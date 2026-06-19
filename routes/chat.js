import { randomBytes } from 'crypto'
import { requireJwt } from '../middleware/requireJwt.js'
import { checkRateLimit } from '../services/rateLimitMemory.js'
import {
  incrementDailyRequests,
  getDailyTokens,
  addDailyTokens,
  secondsUntilMidnight
} from '../services/rateLimitFirestore.js'
import { isBlocklisted } from '../services/blocklist.js'
import { getTask, claimFirstLlmCall } from '../services/agentTasks.js'
import { incrementMonthlyTasks, decrementMonthlyTasks } from '../services/rateLimitFirestore.js'
import { getEnv, GEMINI_BASE, rateLimitConfig } from '../config.js'

// Translates OpenAI messages array → Gemini contents + systemInstruction
function toGeminiContents(messages = []) {
  const systemParts = messages
    .filter(m => m.role === 'system')
    .map(m => ({ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }))

  const contents = messages
    .filter(m => m.role !== 'system')
    .map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }]
    }))

  return {
    contents,
    ...(systemParts.length > 0 && { systemInstruction: { parts: systemParts } })
  }
}

// Converts one Gemini SSE data payload → OpenAI chunk shape
function geminiChunkToOpenAI(id, raw) {
  try {
    const d = JSON.parse(raw)
    const text         = d?.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
    const finishReason = d?.candidates?.[0]?.finishReason
    const usage        = d?.usageMetadata
    return {
      id,
      object: 'chat.completion.chunk',
      choices: [{
        index: 0,
        delta: finishReason ? {} : { content: text },
        finish_reason: finishReason === 'STOP' ? 'stop' : null
      }],
      ...(usage && {
        usage: {
          prompt_tokens:     usage.promptTokenCount     ?? 0,
          completion_tokens: usage.candidatesTokenCount ?? 0,
          total_tokens:      usage.totalTokenCount      ?? 0
        }
      })
    }
  } catch {
    return null
  }
}

export async function chatRoutes(app) {
  // GET /ping — verify Gemini reachability
  app.get('/ping', { preHandler: requireJwt }, async (request, reply) => {
    const model = getEnv('GEMINI_MODEL') ?? 'gemini-2.0-flash'
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
    const identity    = sub ?? deviceId                              // backward-compat with old JWTs
    const effectivePlan = plan ?? (isPremium ? 'subscriber' : 'free') // backward-compat with old JWTs
    const body        = request.body
    const isStream    = body?.stream === true
    const taskId      = request.headers['x-task-id']
    const limits      = rateLimitConfig()

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
      return reply.code(429).send({ error: 'rate_limited', scope: 'minute', retry_after: burst.retryAfter })
    }

    // 4. Daily request limit
    const dayReqs = await incrementDailyRequests(identity)
    if (dayReqs > limits.requestsPerDay) {
      return reply.code(429).send({ error: 'rate_limited', scope: 'day_requests', retry_after: secondsUntilMidnight() })
    }

    // 5. Daily token budget — check before calling Gemini
    const usedTokens = await getDailyTokens(identity)
    if (usedTokens >= limits.tokensPerDay) {
      return reply.code(429).send({ error: 'rate_limited', scope: 'day_tokens', retry_after: secondsUntilMidnight() })
    }

    // 6. Task tracking (only when X-Task-Id is present)
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
          return reply.code(429).send({ error: 'task_limit_reached' })
        }
      }
    }

    // 7. Build Gemini request
    const model = getEnv('GEMINI_MODEL') ?? 'gemini-2.0-flash'
    const { contents, systemInstruction } = toGeminiContents(body.messages)
    const geminiBody = {
      contents,
      ...(systemInstruction && { systemInstruction }),
      generationConfig: { maxOutputTokens: body.max_tokens ?? 4096 }
    }

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

    const chatId = `chatcmpl-${randomBytes(6).toString('hex')}`

    // Non-streaming: collect and re-emit as a single OpenAI response
    if (!isStream) {
      const text = await upstream.text()
      const lines = text.split('\n').filter(l => l.startsWith('data: ') && l.trim() !== 'data: [DONE]')
      let fullText = '', totalTokens = 0
      for (const line of lines) {
        try {
          const d = JSON.parse(line.slice(6))
          fullText    += d?.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
          totalTokens  = d?.usageMetadata?.totalTokenCount ?? totalTokens
        } catch {}
      }
      addDailyTokens(identity, totalTokens).catch(() => {})
      return reply.send({
        id: chatId,
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: fullText }, finish_reason: 'stop' }],
        usage: { total_tokens: totalTokens }
      })
    }

    // Streaming: translate Gemini SSE → OpenAI SSE on the fly
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
