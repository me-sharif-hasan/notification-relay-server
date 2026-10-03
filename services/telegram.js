import { createHash, timingSafeEqual } from 'crypto'
import { getEnv } from '../config.js'

const API = 'https://api.telegram.org'
const MAX_PER_MIN = 15
const MESSAGE_LIMIT = 3800

let windowStart = 0
let sentInWindow = 0
let suppressed = 0

export function telegramConfigured() {
  return Boolean(getEnv('TELEGRAM_BOT_TOKEN') && getEnv('TELEGRAM_CHAT_ID'))
}

// Messages over the per-minute cap are dropped and counted, so a burst of
// installs cannot hit Telegram's own limits. Returns the number dropped
// since the last message that went out.
function takeSlot(now) {
  if (now - windowStart >= 60_000) {
    windowStart = now
    sentInWindow = 0
  }
  if (sentInWindow >= MAX_PER_MIN) {
    suppressed++
    return null
  }
  sentInWindow++
  const dropped = suppressed
  suppressed = 0
  return dropped
}

async function post(method, payload) {
  const res = await fetch(`${API}/bot${getEnv('TELEGRAM_BOT_TOKEN')}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000)
  })
  return res.ok ? { sent: true } : { sent: false, reason: `http_${res.status}` }
}

// Never throws and never reports the underlying error: the request URL holds
// the bot token, so only a short reason code is returned.
export async function sendTelegram(buildHtml) {
  if (!telegramConfigured()) return { sent: false, reason: 'not_configured' }

  const dropped = takeSlot(Date.now())
  if (dropped === null) return { sent: false, reason: 'rate_limited' }

  try {
    return await post('sendMessage', {
      chat_id: getEnv('TELEGRAM_CHAT_ID'),
      text: buildHtml(dropped),
      parse_mode: 'HTML',
      disable_web_page_preview: true
    })
  } catch {
    return { sent: false, reason: 'network' }
  }
}

// Splits at line breaks so each piece stays under Telegram's message limit.
export function splitMessage(text, limit = MESSAGE_LIMIT) {
  const parts = []
  let current = ''
  for (const line of String(text).split('\n')) {
    for (let rest = line; ; rest = rest.slice(limit)) {
      const piece = rest.slice(0, limit)
      if (current && current.length + piece.length + 1 > limit) {
        parts.push(current)
        current = ''
      }
      current += (current ? '\n' : '') + piece
      if (rest.length <= limit) break
    }
  }
  if (current) parts.push(current)
  return parts
}

// Plain text to any chat, in as many messages as it takes. Same silent
// failure behaviour as sendTelegram.
export async function sendText(chatId, text) {
  if (!getEnv('TELEGRAM_BOT_TOKEN')) return { sent: false, reason: 'not_configured' }
  try {
    for (const part of splitMessage(text)) {
      const result = await post('sendMessage', { chat_id: chatId, text: part, disable_web_page_preview: true })
      if (!result.sent) return result
    }
    return { sent: true }
  } catch {
    return { sent: false, reason: 'network' }
  }
}

// Derived from the bot token, so it needs no extra secret to store.
export function webhookSecret() {
  return createHash('sha256').update(`tg-webhook:${getEnv('TELEGRAM_BOT_TOKEN')}`).digest('hex').slice(0, 48)
}

export function secretMatches(received) {
  const expected = Buffer.from(webhookSecret())
  const given = Buffer.from(String(received ?? ''))
  return given.length === expected.length && timingSafeEqual(given, expected)
}

// Idempotent: points Telegram at this relay and sets the command menu.
export async function registerWebhook() {
  if (!telegramConfigured()) return { sent: false, reason: 'not_configured' }
  const base = getEnv('PUBLIC_BASE_URL') || 'https://serverkitrelay.iishanto.com'
  try {
    const hook = await post('setWebhook', {
      url: `${base}/telegram/webhook`,
      secret_token: webhookSecret(),
      allowed_updates: ['message'],
      max_connections: 2
    })
    await post('setMyCommands', {
      commands: [
        { command: 'analysis', description: 'Analyze the last N days of app analytics' },
        { command: 'help', description: 'Show what I can do' }
      ]
    })
    return hook
  } catch {
    return { sent: false, reason: 'network' }
  }
}
