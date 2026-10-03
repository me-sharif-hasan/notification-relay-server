import { sendTelegram } from './telegram.js'
import { getTodayCount } from './surveyStats.js'
import { SOURCE_LABELS, USE_LABELS, escapeHtml, countryFlag, countryName } from './surveyLabels.js'

function place({ country, region, city }) {
  const name = country === 'unknown' ? 'Unknown location' : `${countryName(country)} (${country})`
  const detail = [city, region].filter(Boolean).join(', ')
  return `${countryFlag(country)} ${escapeHtml(name)}${detail ? `, ${escapeHtml(detail)}` : ''}`
}

export function formatInstallMessage(entry, todayCount, dropped = 0) {
  const uses = entry.uses.map(u => USE_LABELS[u] ?? u).join(', ') || 'No answer'
  const lines = [
    '🆕 <b>New ServerKit install</b>',
    place(entry),
    `📣 Source: ${escapeHtml(SOURCE_LABELS[entry.source ?? 'none'])}`,
    `🛠 Uses: ${escapeHtml(uses)}`,
    `📊 Installs today: <b>${todayCount ?? '?'}</b>`
  ]
  if (dropped) lines.push(`(+${dropped} more installs since the last alert)`)
  return lines.join('\n')
}

// Fire and forget: the survey response never waits on Telegram and a failure
// here is intentionally invisible to the app.
export function notifyNewInstall(entry) {
  getTodayCount()
    .catch(() => null)
    .then(todayCount => sendTelegram(dropped => formatInstallMessage(entry, todayCount, dropped)))
    .catch(() => {})
}

export function sendTestMessage() {
  return sendTelegram(() => '✅ <b>ServerKit relay</b>\nTelegram alerts are connected.')
}
