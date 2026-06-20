import { getEnv } from '../config.js'

const BASE = 'https://api.deepseek.com/v1'

function model() {
  return getEnv('DEEPSEEK_MODEL') ?? 'deepseek-chat'
}

function authHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${getEnv('DEEPSEEK_API_KEY')}`
  }
}

// ─── Provider exports ─────────────────────────────────────────────────────────

export async function ping() {
  const res = await fetch(`${BASE}/models`, { headers: authHeaders() })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    const e = new Error(body?.error?.message ?? 'DeepSeek error')
    e.status = res.status
    throw e
  }
}

// DeepSeek is OpenAI-compatible — no translation needed, just swap the model name.
export async function chat(openAIBody) {
  const upstream = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ ...openAIBody, model: model(), stream: false })
  })
  if (!upstream.ok) {
    const err = await upstream.json().catch(() => ({}))
    const e = new Error(err?.error?.message ?? 'DeepSeek error')
    e.status = upstream.status
    throw e
  }
  return upstream.json()
}

async function* readStream(body) {
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
        try { yield JSON.parse(trimmed.slice(6)) } catch {}
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export async function stream(openAIBody) {
  const upstream = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      ...openAIBody,
      model: model(),
      stream: true,
      stream_options: { include_usage: true }
    })
  })
  if (!upstream.ok) {
    const err = await upstream.json().catch(() => ({}))
    const e = new Error(err?.error?.message ?? 'DeepSeek error')
    e.status = upstream.status
    throw e
  }
  return readStream(upstream.body)
}
