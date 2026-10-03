import { admin, db } from '../../firebase.js'
import { telegramConfigured } from '../telegram.js'
import { deliverAnalysis } from './delivery.js'

// 00:00 in GMT+6 is 18:00 UTC.
const RUN_HOUR_UTC = 18
const CATCH_UP_HOURS = 6
const RETRY_AFTER_MS = 30 * 60_000
const DAY_MS = 86_400_000

export function msUntilNextRun(now = Date.now()) {
  const d = new Date(now)
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), RUN_HOUR_UTC)
  return today > now ? today - now : today + DAY_MS - now
}

const dayKey = () => new Date(Date.now() + 6 * 3_600_000).toISOString().slice(0, 10)

// The Firestore document is created once per GMT+6 day, so a restart near
// midnight cannot send the report twice. A failed run releases it for a retry.
async function runDaily(retry = true) {
  if (!telegramConfigured()) return
  const lock = db.collection('analysisRuns').doc(dayKey())
  try {
    await lock.create({ startedAt: admin.firestore.FieldValue.serverTimestamp() })
  } catch {
    return
  }

  const result = await deliverAnalysis({ days: 7 })
  if (result.ok) return
  await lock.delete().catch(() => {})
  if (retry && result.reason !== 'busy') setTimeout(() => runDaily(false).catch(() => {}), RETRY_AFTER_MS)
}

let nextRunAt = null

export function schedulerStatus() {
  return {
    armed: nextRunAt !== null,
    nextRunUtc: nextRunAt?.toISOString() ?? null,
    nextRunGmt6: nextRunAt ? new Date(nextRunAt.getTime() + 6 * 3_600_000).toISOString().replace('T', ' ').slice(0, 16) + ' (GMT+6)' : null
  }
}

export function startDailyAnalysis() {
  const arm = () => {
    const wait = msUntilNextRun()
    nextRunAt = new Date(Date.now() + wait)
    setTimeout(() => {
      runDaily().catch(() => {}).finally(arm)
    }, wait)
  }
  arm()

  const hour = new Date().getUTCHours()
  if (hour >= RUN_HOUR_UTC && hour < RUN_HOUR_UTC + CATCH_UP_HOURS) {
    setTimeout(() => runDaily().catch(() => {}), 30_000)
  }
}
