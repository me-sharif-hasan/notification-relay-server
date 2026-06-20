import { randomBytes } from 'crypto'
import { requireJwt } from '../middleware/requireJwt.js'
import { checkRateLimit } from '../services/rateLimitMemory.js'
import {
  incrementDailyRequests,
  getDailyTokens,
  addDailyTokens,
  secondsUntilMidnight,
  incrementMonthlyTasks,
  decrementMonthlyTasks
} from '../services/rateLimitFirestore.js'
import { isBlocklisted } from '../services/blocklist.js'
import { getTask, claimFirstLlmCall } from '../services/agentTasks.js'
import { getEnv, GEMINI_BASE, rateLimitConfig } from '../config.js'

// ─── OpenAI → Gemini translation ─────────────────────────────────────────────

// Build tool_call_id → function name lookup from message history
function buildToolCallIdMap(messages) {
  const map = {}
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        map[tc.id] = tc.function.name
      }
    }
  }
  return map
}

// Translate OpenAI messages array → Gemini contents + systemInstruction
// Handles: text, tool_calls (assistant), tool results, system
function toGeminiContents(messages = []) {
  const toolCallIdMap = buildToolCallIdMap(messages)

  const systemParts = messages
    .filter(m => m.role === 'system')
    .map(m => ({ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }))

  const contents = []

  for (const msg of messages) {
    if (msg.role === 'system') continue

    if (msg.role === 'user') {
      contents.push({
        role: 'user',
        parts: [{ text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) }]
      })

    } else if (msg.role === 'assistant') {
      if (msg.tool_calls?.length) {
        // assistant with tool calls → Gemini functionCall parts
        contents.push({
          role: 'model',
          parts: msg.tool_calls.map(tc => ({
            functionCall: {
              name: tc.function.name,
              args: JSON.parse(tc.function.arguments)
            }
          }))
        })
      } else {
        contents.push({
          role: 'model',
          parts: [{ text: msg.content ?? '' }]
        })
      }

    } else if (msg.role === 'tool') {
      // tool result → Gemini functionResponse
      const name = toolCallIdMap[msg.tool_call_id] ?? msg.tool_call_id
      contents.push({
        role: 'user',
        parts: [{
          functionResponse: {
            name,
            response: { output: msg.content }
          }
        }]
      })
    }
  }

  return {
    contents,
    ...(systemParts.length > 0 && { systemInstruction: { parts: systemParts } })
  }
}

// Translate OpenAI tools + tool_choice → Gemini tools + tool_config
function toGeminiTools(tools, toolChoice) {
  if (!tools?.length) return {}

  const modeMap = { auto: 'AUTO', none: 'NONE', required: 'ANY' }
  const mode = typeof toolChoice === 'string' ? (modeMap[toolChoice] ?? 'AUTO') : 'AUTO'

  return {
    tools: [{
      functionDeclarations: tools
        .filter(t => t.type === 'function')
        .map(t => ({
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters
        }))
    }],
    tool_config: {
      function_calling_config: { mode }
    }
  }
}

// ─── Gemini → OpenAI translation ─────────────────────────────────────────────

// Translate a full Gemini generateContent response → OpenAI chat.completion
function geminiToOpenAI(chatId, body) {
  const candidate = body?.candidates?.[0]
  const parts     = candidate?.content?.parts ?? []
  const usage     = body?.usageMetadata

  const usageOut = {
    prompt_tokens:     usage?.promptTokenCount     ?? 0,
    completion_tokens: usage?.candidatesTokenCount ?? 0,
    total_tokens:      usage?.totalTokenCount      ?? 0
  }

  const funcParts = parts.filter(p => p.functionCall)

  if (funcParts.length > 0) {
    return {
      id: chatId,
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: funcParts.map((p, i) => ({
            id: `call_${p.functionCall.name}_${String(i).padStart(3, '0')}`,
            type: 'function',
            function: {
              name: p.functionCall.name,
              arguments: JSON.stringify(p.functionCall.args ?? {})
            }
          }))
        },
        finish_reason: 'tool_calls'
      }],
      usage: usageOut
    }
  }

  const text = parts.filter(p => p.text != null).map(p => p.text).join('')
  return {
    id: chatId,
    object: 'chat.completion',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text },
      finish_reason: 'stop'
    }],
    usage: usageOut
  }
}

// Translate one Gemini SSE data payload → OpenAI SSE chunk
function geminiChunkToOpenAI(chatId, raw) {
  try {
    const d         = JSON.parse(raw)
    const parts     = d?.candidates?.[0]?.content?.parts ?? []
    const finish    = d?.candidates?.[0]?.finishReason
    const usage     = d?.usageMetadata
    const funcParts = parts.filter(p => p.functionCall)

    const usageOut = usage ? {
      usage: {
        prompt_tokens:     usage.promptTokenCount     ?? 0,
        completion_tokens: usage.candidatesTokenCount ?? 0,
        total_tokens:      usage.totalTokenCount      ?? 0
      }
    } : {}

    if (funcParts.length > 0) {
      return {
        id: chatId,
        object: 'chat.completion.chunk',
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            content: null,
            tool_calls: funcParts.map((p, i) => ({
              index: i,
              id: `call_${p.functionCall.name}_${String(i).padStart(3, '0')}`,
              type: 'function',
              function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) }
            }))
          },
          finish_reason: 'tool_calls'
        }],
        ...usageOut
      }
    }

    const text = parts.filter(p => p.text != null).map(p => p.text).join('')
    return {
      id: chatId,
      object: 'chat.completion.chunk',
      choices: [{
        index: 0,
        delta: finish ? {} : { content: text },
        finish_reason: finish === 'STOP' ? 'stop' : null
      }],
      ...usageOut
    }
  } catch {
    return null
  }
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function chatRoutes(app) {
  // GET /ping — verify Gemini reachability
  app.get('/ping', { preHandler: requireJwt }, async (request, reply) => {
    const model = getEnv('GEMINI_MODEL') ?? 'gemini-2.5-flash'
    const res = await fetch(
      `${GEMINI_BASE}/${model}?key=${getEnv('GEMINI_API_KEY')}`,
      { headers: { 'Content-Type': 'application/json' } }
    )
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      return reply.code(res.status).send({ ok: false, error: body?.error?.message ?? 'Gemini error' })
    }
    return { ok: true }
  })

  // POST /v1/chat/completions — Gemini relay with full subscription guard
  app.post('/v1/chat/completions', { preHandler: requireJwt }, async (request, reply) => {
    const { sub, plan, deviceId, isPremium } = request.jwtPayload
    const identity      = sub ?? deviceId
    const effectivePlan = plan ?? (isPremium ? 'subscriber' : 'free')
    const body          = request.body
    const isStream      = body?.stream === true
    const taskId        = request.headers['x-task-id']
    const limits        = rateLimitConfig()

    // 1. Plan check
    if (effectivePlan !== 'subscriber' && effectivePlan !== 'subscriber_discounted') {
      return reply.code(403).send({ error: 'subscription_required', plan: effectivePlan })
    }

    // 2. Blocklist check
    if (await isBlocklisted(identity)) {
      return reply.code(403).send({ error: 'subscription_revoked' })
    }

    // 3. Per-minute burst (in-memory)
    const burst = checkRateLimit(identity, limits.requestsPerMin)
    if (burst.limited) {
      request.log.warn({ identity, scope: 'minute', retryAfter: burst.retryAfter }, 'rate limit hit')
      return reply.code(429).send({ error: 'rate_limited', scope: 'minute', retry_after: burst.retryAfter })
    }

    // 4. Daily request limit
    const dayReqs = await incrementDailyRequests(identity)
    if (dayReqs > limits.requestsPerDay) {
      request.log.warn({ identity, scope: 'day_requests', dayReqs, limit: limits.requestsPerDay }, 'rate limit hit')
      return reply.code(429).send({ error: 'rate_limited', scope: 'day_requests', retry_after: secondsUntilMidnight() })
    }

    // 5. Daily token budget — check before calling Gemini
    const usedTokens = await getDailyTokens(identity)
    if (usedTokens >= limits.tokensPerDay) {
      request.log.warn({ identity, scope: 'day_tokens', usedTokens, limit: limits.tokensPerDay }, 'rate limit hit')
      return reply.code(429).send({ error: 'rate_limited', scope: 'day_tokens', retry_after: secondsUntilMidnight() })
    }

    // 6. Task tracking
    if (taskId) {
      const task = await getTask(taskId)
      if (!task || task.ptHash !== identity) {
        return reply.code(403).send({ error: 'invalid_task_id' })
      }
      const isFirst = await claimFirstLlmCall(taskId)
      if (isFirst) {
        const newCount = await incrementMonthlyTasks(identity)
        if (newCount > limits.tasksPerMonth) {
          await decrementMonthlyTasks(identity)
          request.log.warn({ identity, scope: 'monthly_tasks', newCount, limit: limits.tasksPerMonth }, 'rate limit hit')
          return reply.code(429).send({ error: 'task_limit_reached' })
        }
      }
    }

    // 7. Build Gemini request body
    const model = getEnv('GEMINI_MODEL') ?? 'gemini-2.5-flash'
    const { contents, systemInstruction } = toGeminiContents(body.messages)
    const toolsPayload = toGeminiTools(body.tools, body.tool_choice)

    const geminiBody = {
      contents,
      ...(systemInstruction && { systemInstruction }),
      ...toolsPayload,
      generationConfig: { maxOutputTokens: body.max_tokens ?? 4096 }
    }

    const chatId = `chatcmpl-${randomBytes(6).toString('hex')}`

    // ── Non-streaming: single JSON response ──────────────────────────────────
    if (!isStream) {
      const upstream = await fetch(
        `${GEMINI_BASE}/${model}:generateContent?key=${getEnv('GEMINI_API_KEY')}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(geminiBody)
        }
      )

      if (!upstream.ok) {
        const err = await upstream.json().catch(() => ({}))
        return reply.code(upstream.status).send({ error: err?.error?.message ?? 'Gemini error' })
      }

      const geminiRes = await upstream.json()
      const totalTokens = geminiRes?.usageMetadata?.totalTokenCount ?? 0
      addDailyTokens(identity, totalTokens).catch(() => {})

      return reply.send(geminiToOpenAI(chatId, geminiRes))
    }

    // ── Streaming: translate Gemini SSE → OpenAI SSE ─────────────────────────
    const upstream = await fetch(
      `${GEMINI_BASE}/${model}:streamGenerateContent?key=${getEnv('GEMINI_API_KEY')}&alt=sse`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiBody)
      }
    )

    if (!upstream.ok) {
      const err = await upstream.json().catch(() => ({}))
      return reply.code(upstream.status).send({ error: err?.error?.message ?? 'Gemini error' })
    }

    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    })

    const reader  = upstream.body.getReader()
    const decoder = new TextDecoder()
    let lineBuf     = ''
    let totalTokens = 0

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        lineBuf += decoder.decode(value, { stream: true })
        const lines = lineBuf.split('\n')
        lineBuf = lines.pop()
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data: ') || trimmed === 'data: [DONE]') continue
          const chunk = geminiChunkToOpenAI(chatId, trimmed.slice(6))
          if (!chunk) continue
          if (chunk.usage?.total_tokens) totalTokens = chunk.usage.total_tokens
          raw.write(`data: ${JSON.stringify(chunk)}\n\n`)
        }
      }
    } catch (err) {
      app.log.error(err, 'Gemini SSE stream error')
    } finally {
      reader.releaseLock()
      raw.write('data: [DONE]\n\n')
      raw.end()
      if (totalTokens) addDailyTokens(identity, totalTokens).catch(() => {})
    }
  })
}
