import { getEnv } from '../config.js'
import { registerWebhook, secretMatches, sendText, telegramConfigured } from '../services/telegram.js'
import { analysisBusy, deliverAnalysis } from '../services/analytics/delivery.js'
import { MAX_DAYS } from '../services/analytics/report.js'

const ASK_TTL_MS = 5 * 60_000
const MAX_QUESTION = 300

const HELP = [
  'ServerKit analytics bot',
  '',
  '/analysis  asks how many days to analyze',
  '/analysis 45  analyzes the last 45 days right away',
  `/analysis 45 why are installs flat?  adds a question for the analyst (days: 1 to ${MAX_DAYS})`,
  '/cancel  stops a pending question',
  '',
  'A report is also sent every day at 00:00 GMT+6 for the last 7 days.'
].join('\n')

const ASK = `How many days should I analyze? Send a number from 1 to ${MAX_DAYS}, for example 45. You can add a question after it. /cancel to stop.`

let waitingUntil = 0

async function startAnalysis(chatId, rawDays, question) {
  const days = Math.min(Number(rawDays), MAX_DAYS)
  if (!Number.isInteger(days) || days < 1) {
    await sendText(chatId, `Please send a whole number from 1 to ${MAX_DAYS}.`)
    return
  }
  if (analysisBusy()) {
    await sendText(chatId, 'An analysis is already running. Try again in a minute.')
    return
  }
  waitingUntil = 0
  if (Number(rawDays) > MAX_DAYS) await sendText(chatId, `The longest window is ${MAX_DAYS} days, so I will use that.`)
  await deliverAnalysis({ chatId, days, question: (question ?? '').trim().slice(0, MAX_QUESTION), announce: true })
}

// Only the owner's private chat is served. Anyone else, and anything that is
// not a recognised message, is ignored without a reply.
export async function handleUpdate(update, now = Date.now()) {
  const message = update?.message
  const ownerId = String(getEnv('TELEGRAM_CHAT_ID') ?? '')
  if (!message?.text || message.chat?.type !== 'private') return
  if (!ownerId || String(message.from?.id) !== ownerId) return

  const chatId = message.chat.id
  const text = message.text.trim()
  const command = /^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text)

  if (command) {
    const [, name, rest = ''] = command
    if (name === 'start' || name === 'help') return void await sendText(chatId, HELP)
    if (name === 'cancel') {
      waitingUntil = 0
      return void await sendText(chatId, 'Cancelled.')
    }
    if (name === 'analysis') {
      const match = /^(\d+)(?:\s+([\s\S]+))?$/.exec(rest.trim())
      if (match) return await startAnalysis(chatId, match[1], match[2])
      waitingUntil = now + ASK_TTL_MS
      return void await sendText(chatId, ASK)
    }
    return
  }

  if (now < waitingUntil) {
    const match = /^(\d+)(?:\s+([\s\S]+))?$/.exec(text)
    if (!match) return void await sendText(chatId, `Please send a number from 1 to ${MAX_DAYS}, or /cancel.`)
    await startAnalysis(chatId, match[1], match[2])
  }
}

export async function telegramWebhookRoutes(app) {
  // Telegram calls this for every message to the bot. The secret header proves
  // the call is from Telegram; the reply is always quick and the work runs
  // after it, so Telegram never retries.
  app.post('/telegram/webhook', { logLevel: 'warn' }, async (request, reply) => {
    if (!telegramConfigured() || !secretMatches(request.headers['x-telegram-bot-api-secret-token'])) {
      return reply.code(401).send({ ok: false })
    }
    handleUpdate(request.body).catch(() => {})
    return { ok: true }
  })
}

export function setupTelegramWebhook() {
  registerWebhook().catch(() => {})
}
