import { getEnv } from '../../config.js'
import { sendText } from '../telegram.js'
import { runAnalysis } from './report.js'

let running = false

export const analysisBusy = () => running

// Runs one analysis and posts it to Telegram. Only one runs at a time, and it
// never throws: a failure becomes a short message to the owner.
export async function deliverAnalysis({ chatId = getEnv('TELEGRAM_CHAT_ID'), days, question = '', announce = false }) {
  if (running) return { ok: false, reason: 'busy' }
  running = true
  try {
    if (announce) await sendText(chatId, `⏳ Analyzing the last ${days} days. This can take a minute.`)
    const { report, insights } = await runAnalysis({ days, question })
    await sendText(chatId, report)
    await sendText(chatId, insights)
    return { ok: true }
  } catch (err) {
    await sendText(chatId, `⚠️ Analysis failed (${err.message}). Nothing was changed; try again later.`)
    return { ok: false, reason: err.message }
  } finally {
    running = false
  }
}
