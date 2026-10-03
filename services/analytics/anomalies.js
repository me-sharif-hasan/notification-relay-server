import { KEY_EVENTS, NOISY_EVENTS } from './constants.js'

const BASELINE_DAYS = 14
const MIN_BASELINE_DAYS = 4
const SPIKE_RATIO = 2.5
const DROP_RATIO = 0.5
const MIN_Z = 3
const MIN_USERS = 2
const OVER_TRAFFIC = 2
const MAX_REPORTED = 8
const BROAD_GROWTH = 1.3

const mean = values => values.reduce((a, b) => a + b, 0) / values.length
const stdev = (values, avg) => Math.sqrt(values.reduce((a, b) => a + (b - avg) ** 2, 0) / values.length)

// How much busier the latest day was than usual, never below 1. It is computed
// from every other event, so a genuine spike in one event cannot hide behind
// the traffic it caused itself.
function trafficGrowth(others) {
  const base = others.slice(Math.max(0, others.length - 1 - BASELINE_DAYS), -1)
  return Math.max(1, others.at(-1) / Math.max(mean(base), 1))
}

// The latest day against that series' own recent baseline. A rise only counts
// as a spike when it is large (ratio), statistically unusual (z score), well
// above that day's overall traffic growth, and not one person's doing, so
// events that are always high, or that rise only because the whole day was
// busy, stay quiet.
function check(label, series, { minRecent, watchDrop, users = null, traffic = 1, allowSpike = true, overTraffic = OVER_TRAFFIC }) {
  const last = series.length - 1
  const base = series.slice(Math.max(0, last - BASELINE_DAYS), last)
  if (base.length < MIN_BASELINE_DAYS) return null

  const avg = mean(base)
  const recent = series[last]
  const spread = Math.max(stdev(base, avg), Math.sqrt(avg), 1)
  const ratio = recent / Math.max(avg, 1)

  const spiked = allowSpike && recent >= minRecent && ratio >= SPIKE_RATIO && (recent - avg) / spread >= MIN_Z &&
    ratio / traffic >= overTraffic && (users === null || users >= MIN_USERS)
  if (spiked) return { event: label, kind: 'spike', recent, baseline: Math.round(avg), ratio: +ratio.toFixed(1), users }

  if (watchDrop && avg >= minRecent && recent <= DROP_RATIO * avg && (avg - recent) / spread >= MIN_Z) {
    return { event: label, kind: 'drop', recent, baseline: Math.round(avg), ratio: +(recent / avg).toFixed(2), users }
  }
  return null
}

// Deterministic: this decides what counts as a problem, not the language model.
export function detectAnomalies(stats) {
  if (stats.days.length < MIN_BASELINE_DAYS + 1) return []

  const events = stats.daily.events

  const found = []
  const totals = [
    ['new installs', stats.daily.newInstalls, { minRecent: 5, watchDrop: true }],
    ['uninstalls', stats.daily.uninstalls, { minRecent: 5, watchDrop: false }],
    // More events from the same few users is not a spike worth reporting.
    ['total events', events, { minRecent: 100, watchDrop: true, allowSpike: trafficGrowth(stats.daily.users) >= BROAD_GROWTH }],
    ['active users', stats.daily.users, { minRecent: 20, watchDrop: true }]
  ]
  for (const [label, series, opts] of totals) {
    const hit = check(label, series, opts)
    if (hit) found.push(hit)
  }
  for (const [name, entry] of Object.entries(stats.events)) {
    const hit = check(name, entry.daily, {
      minRecent: 15,
      watchDrop: KEY_EVENTS.includes(name),
      users: entry.latestUsers,
      overTraffic: NOISY_EVENTS.has(name) ? OVER_TRAFFIC * 2 : OVER_TRAFFIC,
      traffic: trafficGrowth(events.map((v, i) => v - entry.daily[i]))
    })
    if (hit) found.push(hit)
  }

  const weight = a => (a.kind === 'spike' ? a.ratio : 1 / Math.max(a.ratio, 0.01))
  return found.sort((a, b) => weight(b) - weight(a)).slice(0, MAX_REPORTED)
}
