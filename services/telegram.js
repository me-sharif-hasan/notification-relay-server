import { getEnv } from '../config.js'

const API = 'https://api.telegram.org'
const MAX_PER_MIN = 15

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

// Never throws and never reports the underlying error: the request URL holds
// the bot token, so only a short reason code is returned.
export async function sendTelegram(buildHtml) {
  const token = getEnv('TELEGRAM_BOT_TOKEN')
  const chatId = getEnv('TELEGRAM_CHAT_ID')
  if (!token || !chatId) return { sent: false, reason: 'not_configured' }

  const dropped = takeSlot(Date.now())
  if (dropped === null) return { sent: false, reason: 'rate_limited' }

  try {
    const res = await fetch(`${API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: buildHtml(dropped),
        parse_mode: 'HTML',
        disable_web_page_preview: true
      }),
      signal: AbortSignal.timeout(5000)
    })
    return res.ok ? { sent: true } : { sent: false, reason: `http_${res.status}` }
  } catch {
    return { sent: false, reason: 'network' }
  }
}
