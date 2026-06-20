import { randomBytes } from 'crypto'
import { getEnv, GEMINI_BASE } from '../config.js'

// ─── OpenAI → Gemini translation ─────────────────────────────────────────────

function buildToolCallIdMap(messages) {
  const map = {}
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) map[tc.id] = tc.function.name
    }
  }
  return map
}

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
    tool_config: { function_calling_config: { mode } }
  }
}

function buildGeminiBody(openAIBody) {
  const { contents, systemInstruction } = toGeminiContents(openAIBody.messages)
  const toolsPayload = toGeminiTools(openAIBody.tools, openAIBody.tool_choice)
  return {
    contents,
    ...(systemInstruction && { systemInstruction }),
    ...toolsPayload,
    generationConfig: { maxOutputTokens: openAIBody.max_tokens ?? 4096 }
  }
}

// ─── Gemini → OpenAI translation ─────────────────────────────────────────────

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
      id: chatId, object: 'chat.completion',
      choices: [{
        index: 0,
        message: {
          role: 'assistant', content: null,
          tool_calls: funcParts.map((p, i) => ({
            id: `call_${p.functionCall.name}_${String(i).padStart(3, '0')}`,
            type: 'function',
            function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) }
          }))
        },
        finish_reason: 'tool_calls'
      }],
      usage: usageOut
    }
  }

  const text = parts.filter(p => p.text != null).map(p => p.text).join('')
  return {
    id: chatId, object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: usageOut
  }
}

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
        id: chatId, object: 'chat.completion.chunk',
        choices: [{
          index: 0,
          delta: {
            role: 'assistant', content: null,
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
      id: chatId, object: 'chat.completion.chunk',
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

// ─── Streaming helper (async generator) ──────────────────────────────────────

async function* readStream(body, chatId) {
  const reader  = body.getReader()
  const decoder = new TextDecoder()
  let lineBuf   = ''
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
        if (chunk) yield chunk
      }
    }
  } finally {
    reader.releaseLock()
  }
}

// ─── Provider exports ─────────────────────────────────────────────────────────

export async function ping() {
  const model = getEnv('GEMINI_MODEL') ?? 'gemini-2.5-flash'
  const res = await fetch(`${GEMINI_BASE}/${model}?key=${getEnv('GEMINI_API_KEY')}`)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    const e = new Error(body?.error?.message ?? 'Gemini error')
    e.status = res.status
    throw e
  }
}

export async function chat(openAIBody, { model: modelOverride } = {}) {
  const model      = modelOverride ?? getEnv('GEMINI_MODEL') ?? 'gemini-2.5-flash'
  const geminiBody = buildGeminiBody(openAIBody)

  const upstream = await fetch(
    `${GEMINI_BASE}/${model}:generateContent?key=${getEnv('GEMINI_API_KEY')}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(geminiBody) }
  )
  if (!upstream.ok) {
    const err = await upstream.json().catch(() => ({}))
    const e = new Error(err?.error?.message ?? 'Gemini error')
    e.status = upstream.status
    throw e
  }

  const chatId = `chatcmpl-${randomBytes(6).toString('hex')}`
  return geminiToOpenAI(chatId, await upstream.json())
}

export async function stream(openAIBody, { model: modelOverride } = {}) {
  const model      = modelOverride ?? getEnv('GEMINI_MODEL') ?? 'gemini-2.5-flash'
  const geminiBody = buildGeminiBody(openAIBody)

  const upstream = await fetch(
    `${GEMINI_BASE}/${model}:streamGenerateContent?key=${getEnv('GEMINI_API_KEY')}&alt=sse`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(geminiBody) }
  )
  if (!upstream.ok) {
    const err = await upstream.json().catch(() => ({}))
    const e = new Error(err?.error?.message ?? 'Gemini error')
    e.status = upstream.status
    throw e
  }

  const chatId = `chatcmpl-${randomBytes(6).toString('hex')}`
  return readStream(upstream.body, chatId)
}
