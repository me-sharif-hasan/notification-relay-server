import { bigQueryConfigured, listEventDays, streamDay } from './bigquery.js'
import { createCollector, halfChange, unusedFeatures } from './eventStats.js'
import { detectAnomalies } from './anomalies.js'
import { runAgent } from './agent.js'
import { KNOWN_FEATURES, NOISY_EVENTS } from './constants.js'
import { series } from './tools.js'

export const MAX_DAYS = 90
const MAX_ROWS = 800_000
const READ_CONCURRENCY = 4
const OVERVIEW_TOKEN_BUDGET = 5000

const estimateTokens = text => Math.ceil(text.length / 3)
const pad = n => String(n).padStart(2, '0')

function addDays(day, n) {
  const d = new Date(Date.UTC(+day.slice(0, 4), +day.slice(4, 6) - 1, +day.slice(6, 8) + n))
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
}

const fmtDay = day => new Date(Date.UTC(+day.slice(0, 4), +day.slice(4, 6) - 1, +day.slice(6, 8)))
  .toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' })

const fmtNow = now => `${now.toLocaleString('en-GB', {
  timeZone: 'Asia/Dhaka', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
})} (GMT+6)`

const num = n => Number(n).toLocaleString('en-US')

function change(cur, prev) {
  if (prev === undefined || prev === null) return ''
  if (prev === 0) return cur === 0 ? ' (no change)' : ' (new)'
  const p = Math.round(((cur - prev) / prev) * 100)
  return ` (${p >= 0 ? '+' : ''}${p}% vs previous period)`
}

// The latest finished export table anchors the window, because GA4 exports
// lag the calendar by about a day.
export function pickWindows(allDays, days) {
  const latest = allDays.at(-1)
  const inRange = (from, to) => allDays.filter(d => d >= from && d <= to)
  const current = inRange(addDays(latest, -(days - 1)), latest)
  const prior = inRange(addDays(latest, -(2 * days - 1)), addDays(latest, -days))
  // A comparison is only fair against a previous period of the same length.
  return { latest, current, prior: prior.length === current.length ? prior : [] }
}

// Several days are read at once; the collector is synchronous and keyed by
// day, so the order they finish in does not matter.
async function collect(dayList, rowBudget) {
  const collector = createCollector(dayList)
  const queue = [...dayList]
  let rows = 0
  let truncated = false

  async function worker() {
    for (let day = queue.shift(); day && !truncated; day = queue.shift()) {
      for await (const ev of streamDay(day)) {
        if (rows >= rowBudget) {
          truncated = true
          return
        }
        rows++
        collector.add(day, ev)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, dayList.length) }, worker))
  return { stats: collector.finish(), rows, truncated }
}

function featureRanking(stats) {
  const ranked = Object.entries(stats.features)
    .map(([name, f]) => ({ name, users: f.users, events: f.total }))
    .sort((a, b) => b.users - a.users || b.events - a.events)
  return {
    ranked,
    top: ranked[0],
    least: ranked.length > 1 ? ranked.at(-1) : null,
    neverUsed: unusedFeatures(stats, KNOWN_FEATURES)
  }
}

function productEvents(stats, limit) {
  return Object.entries(stats.events)
    .filter(([name]) => !NOISY_EVENTS.has(name))
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, limit)
}

function spikeLines(stats, anomalies) {
  const lastDay = fmtDay(stats.days.at(-1))
  if (!anomalies.length) return ['🚨 Spikes: none. Nothing unusual against the recent baseline.']
  return ['🚨 Spikes (latest day vs usual):', ...anomalies.map(a => {
    const who = a.users ? `, ${num(a.users)} users` : ''
    return a.kind === 'spike'
      ? `🔺 ${a.event}: ${num(a.recent)} on ${lastDay} vs about ${num(a.baseline)}/day usual (${a.ratio}x${who})`
      : `🔻 ${a.event} fell: ${num(a.recent)} on ${lastDay} vs about ${num(a.baseline)}/day usual`
  })]
}

export function formatReport({ stats, prior, anomalies, now, truncated }) {
  const t = stats.totals
  const p = prior?.totals
  const f = featureRanking(stats)
  const net = t.newInstalls - t.uninstalls
  const lines = [
    '📊 ServerKit analytics',
    `📅 ${fmtNow(now)}`,
    `🗓 Window: ${fmtDay(stats.days[0])} to ${fmtDay(stats.days.at(-1))} (${stats.days.length} days with data)`,
    'GA4 exports lag about a day, so the newest day is the latest finished one.',
    '',
    '📈 Events',
    `• Total events: ${num(t.events)}${change(t.events, p?.events)}`,
    `• Active users: ${num(t.users)}${change(t.users, p?.users)}`,
    `• Sessions: ${num(t.sessions)}${change(t.sessions, p?.sessions)}`,
    `• Top events: ${productEvents(stats, 8).map(([n, e]) => `${n} ${num(e.total)}`).join(', ') || 'none'}`,
    '',
    f.top ? `🏆 Top feature: ${f.top.name} (${num(f.top.users)} users, ${num(f.top.events)} events)` : '🏆 Top feature: no feature events yet',
    f.least ? `🪫 Least used feature: ${f.least.name} (${num(f.least.users)} users, ${num(f.least.events)} events)` : '🪫 Least used feature: not enough data',
    f.neverUsed.length ? `💤 Not used at all: ${f.neverUsed.slice(0, 12).join(', ')}` : '💤 Every known feature was used',
    '',
    '📲 Installs',
    `• New installs: ${num(t.newInstalls)}${change(t.newInstalls, p?.newInstalls)}`,
    `• Uninstalls: ${num(t.uninstalls)}${change(t.uninstalls, p?.uninstalls)}`,
    `• Net installs: ${net >= 0 ? '+' : ''}${num(net)}`,
    '',
    ...spikeLines(stats, anomalies)
  ]
  if (truncated) lines.push('', 'Note: the window was larger than the row limit, so the oldest events were not all counted.')
  return lines.join('\n')
}

function overviewObject(stats, prior, anomalies, level) {
  const t = stats.totals
  const f = featureRanking(stats)
  const small = level >= 1
  const cut = (list, n) => list.slice(0, n)
  const obj = {
    window: { from: stats.days[0], to: stats.days.at(-1), daysWithData: stats.days.length },
    totals: { events: t.events, activeUsers: t.users, sessions: t.sessions, newInstalls: t.newInstalls, uninstalls: t.uninstalls, net: t.newInstalls - t.uninstalls },
    ...(prior ? { previousPeriodTotals: { events: prior.totals.events, activeUsers: prior.totals.users, newInstalls: prior.totals.newInstalls, uninstalls: prior.totals.uninstalls } } : {}),
    SPIKES: anomalies.map(a => ({ event: a.event, kind: a.kind, latestDay: a.recent, usualPerDay: a.baseline, ratio: a.ratio, usersOnLatestDay: a.users })),
    topProductEvents: productEvents(stats, small ? 6 : 12).map(([name, e]) => [name, e.total, e.users, e.total >= 20 ? halfChange(e.daily) : null]),
    featuresByUsers: {
      top: cut(f.ranked, small ? 4 : 6).map(x => [x.name, x.users, x.events]),
      bottom: cut([...f.ranked].reverse(), small ? 4 : 6).map(x => [x.name, x.users, x.events]),
      neverUsed: f.neverUsed.slice(0, 12)
    },
    funnelUsers: stats.funnel,
    legend: 'event arrays are [name, total events, distinct users, change % of second half vs first half]'
  }
  if (level < 2) {
    obj.daily = {
      events: series(stats.days, stats.daily.events),
      activeUsers: series(stats.days, stats.daily.users),
      newInstalls: series(stats.days, stats.daily.newInstalls),
      uninstalls: series(stats.days, stats.daily.uninstalls)
    }
  }
  if (level < 1) {
    obj.appVersions = Object.entries(stats.versions).sort((a, b) => b[1] - a[1]).slice(0, 5)
    obj.countries = Object.entries(stats.countries).sort((a, b) => b[1] - a[1]).slice(0, 6)
  }
  return obj
}

// Trims detail until the opening prompt fits the budget. Anything dropped here
// is still available to the model through its tools.
export function buildOverview(stats, prior, anomalies) {
  let text = ''
  for (let level = 0; level < 3; level++) {
    text = JSON.stringify(overviewObject(stats, prior, anomalies, level))
    if (estimateTokens(text) <= OVERVIEW_TOKEN_BUDGET) break
  }
  return text
}

function formatInsights(text, steps) {
  const looked = steps.map(s => `${s.tool}(${Object.values(s.args ?? {}).join(', ')})`).join('; ')
  return ['🧠 Insights from the analyst agent', '', text, '', looked ? `🔎 Investigated: ${looked}` : '🔎 No drill-down was needed.'].join('\n')
}

export async function runAnalysis({ days, question = '', now = new Date() }) {
  if (!bigQueryConfigured()) throw new Error('analytics_not_configured')

  const allDays = await listEventDays()
  if (!allDays.length) throw new Error('no_event_tables')

  const window = pickWindows(allDays, Math.min(Math.max(days, 1), MAX_DAYS))
  const current = await collect(window.current, MAX_ROWS)
  const previous = window.prior.length ? await collect(window.prior, Math.max(0, MAX_ROWS - current.rows)) : null

  const anomalies = detectAnomalies(current.stats)
  const report = formatReport({ stats: current.stats, prior: previous?.stats, anomalies, now, truncated: current.truncated })

  let insights
  try {
    const overview = buildOverview(current.stats, previous?.stats, anomalies)
    const { text, steps } = await runAgent({ stats: current.stats, anomalies, overview, question })
    insights = formatInsights(text, steps)
  } catch (err) {
    insights = `🧠 AI insights are unavailable right now (${err.message}). The numbers above are still correct.`
  }
  return { report, insights }
}
