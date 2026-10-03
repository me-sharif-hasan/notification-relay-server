import { getEnv } from '../../config.js'
import { TOOL_DEFINITIONS, runTool } from './tools.js'

const API_URL = 'https://api.deepseek.com/chat/completions'
const MAX_TOOL_CALLS = 6
const MAX_TURNS = 10
const MAX_REPAIRS = 2
const REQUEST_TIMEOUT_MS = 90_000

// DeepSeek sometimes prints its tool call as text instead of using the tool
// interface. That must never reach the owner as an answer.
const TOOL_MARKUP = /DSML|<\s*invoke\b|<\s*function_calls/i

const SYSTEM_PROMPT = `You are a senior DevOps and mobile app performance analyst advising the solo owner of ServerKit, an Android app for managing Linux servers over SSH (terminal, file manager, monitoring, Docker, Kubernetes, SSL, an on-device lab VM, an AI agent, an uptime monitor). The data comes from the app's GA4 BigQuery export.

Rules:
1. A problem is only something listed under SPIKES (an event that jumped, or a key metric that fell, against its own recent baseline). If SPIKES is empty, say that nothing is spiking and do not invent problems.
2. connection_error, notification_*, tab_open, empty_state_shown and similar events are normal background noise (users pointing the app at their own servers). Never call them a problem unless they appear in SPIKES. server_connected, server_added, first_open and onboarding_completed are the healthy-product signals.
3. Before concluding, investigate every spike with the tools: first its trend, then a breakdown by a parameter such as source, server_type, protocol, reason or version. You may call at most ${MAX_TOOL_CALLS} tools in total. Do not repeat a call.
4. Base every claim on numbers from the data or the tools. If the data is too thin to conclude, say so plainly.
5. Output plain text only: no markdown, no asterisks, no headings with #. At most 2800 characters, in exactly this order:
Verdict: one line.
What changed: up to 4 lines, each starting with "- ".
What to do now: 3 to 5 numbered, concrete, prioritized actions.
Watch next: 1 or 2 metrics.`

async function complete(messages, withTools) {
  const key = getEnv('ANALYTICS_DEEPSEEK_API_KEY')
  if (!key) throw new Error('deepseek_not_configured')

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: getEnv('ANALYTICS_DEEPSEEK_MODEL') || 'deepseek-chat',
      messages,
      ...(withTools ? { tools: TOOL_DEFINITIONS, tool_choice: 'auto' } : {}),
      temperature: 0.2,
      max_tokens: 1200,
      stream: false
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  if (!res.ok) throw new Error(`deepseek_http_${res.status}`)
  return (await res.json()).choices?.[0]?.message ?? {}
}

// The model reads plain text, so markdown it sneaks in is stripped.
export function toPlainText(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, m => m.replace(/```/g, ''))
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*|__|`/g, '')
    .trim()
}

// Gives the model the overview and the tools, lets it investigate for a
// bounded number of calls, then returns its written insights. The window size
// never changes the prompt size: detail is fetched on demand and capped.
export async function runAgent({ stats, anomalies, overview, question }) {
  const ctx = { stats, anomalies }
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `${overview}${question ? `\n\nThe owner also asks: ${question}` : ''}\n\nInvestigate and write your analysis.`
    }
  ]
  const steps = []
  const seen = new Set()
  let repairs = 0

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const exhausted = steps.length >= MAX_TOOL_CALLS
    const message = await complete(messages, !exhausted)
    const calls = exhausted ? [] : (message.tool_calls ?? [])

    if (!calls.length) {
      if (TOOL_MARKUP.test(message.content ?? '')) {
        if (++repairs > MAX_REPAIRS) throw new Error('deepseek_bad_output')
        messages.push({
          role: 'user',
          content: 'Your last reply contained raw tool-call markup instead of a result. Use the tool interface for tools, or if you have enough data write the final analysis now in plain text.'
        })
        continue
      }
      const text = toPlainText(message.content)
      if (text) return { text, steps }
      if (++repairs > MAX_REPAIRS) throw new Error('deepseek_empty')
      messages.push({ role: 'user', content: 'Your reply was empty. Write the final analysis now in plain text, using what you already have.' })
      continue
    }

    messages.push({ role: 'assistant', content: message.content ?? '', tool_calls: calls })
    for (const call of calls) {
      const name = call.function?.name
      let args = {}
      try { args = JSON.parse(call.function?.arguments || '{}') } catch { args = null }

      const signature = `${name}:${JSON.stringify(args)}`
      let result
      if (args === null) result = JSON.stringify({ error: 'arguments were not valid JSON' })
      else if (steps.length >= MAX_TOOL_CALLS) result = JSON.stringify({ error: 'tool budget used, write the final answer' })
      else if (seen.has(signature)) result = JSON.stringify({ error: 'already called with these arguments' })
      else {
        seen.add(signature)
        steps.push({ tool: name, args })
        result = runTool(name, args, ctx)
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: result })
    }
  }
  throw new Error('deepseek_no_answer')
}
