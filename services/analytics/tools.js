import { KNOWN_FEATURES, NOISY_EVENTS } from './constants.js'
import { halfChange, unusedFeatures } from './eventStats.js'

const MAX_RESULT_CHARS = 3000
const DAILY_POINTS_LIMIT = 31

const label = day => `${day.slice(4, 6)}-${day.slice(6, 8)}`

// Daily points, or weekly buckets once the window is longer than a month so a
// 90 day window never produces an oversized tool result.
export function series(days, values) {
  if (days.length <= DAILY_POINTS_LIMIT) return days.map((d, i) => ({ d: label(d), n: values[i] }))
  const out = []
  for (let i = 0; i < days.length; i += 7) {
    const end = Math.min(i + 7, days.length)
    out.push({ d: `${label(days[i])}..${label(days[end - 1])}`, n: values.slice(i, end).reduce((a, b) => a + b, 0) })
  }
  return out
}

const clamp = (value, min, max, fallback) => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback
}

function unknownEvent(stats, name) {
  const needle = String(name ?? '').toLowerCase()
  return { error: 'unknown event', suggestions: Object.keys(stats.events).filter(n => n.includes(needle)).slice(0, 8) }
}

const handlers = {
  get_event_trend({ event }, { stats }) {
    const e = stats.events[event]
    if (!e) return unknownEvent(stats, event)
    const baseline = e.daily.slice(0, -1)
    return {
      event,
      totalEvents: e.total,
      users: e.users,
      usualPerDay: baseline.length ? Math.round(baseline.reduce((a, b) => a + b, 0) / baseline.length) : null,
      latestDay: e.daily.at(-1),
      changePct: halfChange(e.daily),
      series: series(stats.days, e.daily)
    }
  },

  list_events({ sort = 'events', limit, include_noisy: includeNoisy = false }, { stats }) {
    const rows = Object.entries(stats.events)
      .filter(([name]) => includeNoisy || !NOISY_EVENTS.has(name))
      .map(([event, e]) => ({ event, events: e.total, users: e.users, changePct: e.total >= 20 ? halfChange(e.daily) : null }))
    const orders = {
      events: (a, b) => b.events - a.events,
      users: (a, b) => b.users - a.users,
      growth: (a, b) => (b.changePct ?? -1e9) - (a.changePct ?? -1e9),
      decline: (a, b) => (a.changePct ?? 1e9) - (b.changePct ?? 1e9)
    }
    return rows.sort(orders[sort] ?? orders.events).slice(0, clamp(limit, 1, 20, 10))
  },

  get_feature_usage({ order = 'most', limit }, { stats }) {
    const rows = Object.entries(stats.features)
      .map(([feature, f]) => ({ feature, users: f.users, events: f.total, changePct: halfChange(f.daily) }))
      .sort((a, b) => (order === 'least' ? a.users - b.users || a.events - b.events : b.users - a.users || b.events - a.events))
      .slice(0, clamp(limit, 1, 20, 10))
    const neverUsed = unusedFeatures(stats, KNOWN_FEATURES)
    return order === 'least' ? { features: rows, neverUsed } : { features: rows }
  },

  get_breakdown({ event, param }, { stats }) {
    const e = stats.events[event]
    if (!e) return unknownEvent(stats, event)
    const byKey = stats.params[event] ?? {}
    const values = byKey[param]
    if (!values) return { error: 'parameter not tracked for this event', availableParams: Object.keys(byKey) }
    const total = Object.values(values).reduce((a, b) => a + b, 0)
    return {
      event,
      param,
      values: Object.entries(values).sort((a, b) => b[1] - a[1]).slice(0, 12)
        .map(([value, count]) => ({ value, count, pct: Math.round((count / total) * 100) }))
    }
  },

  get_installs(_args, { stats }) {
    const { newInstalls, uninstalls } = stats.daily
    return {
      totals: { newInstalls: stats.totals.newInstalls, uninstalls: stats.totals.uninstalls, net: stats.totals.newInstalls - stats.totals.uninstalls },
      newInstalls: series(stats.days, newInstalls),
      uninstalls: series(stats.days, uninstalls)
    }
  },

  get_funnel(_args, { stats }) {
    const steps = Object.entries(stats.funnel)
    const first = steps[0]?.[1] || 0
    return steps.map(([step, users]) => ({ step, users, pctOfFirst: first ? Math.round((users / first) * 100) : null }))
  }
}

export const TOOL_DEFINITIONS = [
  ['get_event_trend', 'Daily counts for one event across the window, with its usual daily level and the latest day. Use it to inspect a spike.',
    { event: { type: 'string', description: 'Exact event name, e.g. connection_error' } }, ['event']],
  ['list_events', 'Rank events by total count, distinct users, growth or decline. Noisy background events are hidden unless include_noisy is true.',
    { sort: { type: 'string', enum: ['events', 'users', 'growth', 'decline'] }, limit: { type: 'integer' }, include_noisy: { type: 'boolean' } }, []],
  ['get_feature_usage', 'Feature usage ranked by distinct users. order=least also lists known features with zero use.',
    { order: { type: 'string', enum: ['most', 'least'] }, limit: { type: 'integer' } }, []],
  ['get_breakdown', 'How one event splits across the values of one parameter (for example source, server_type, protocol, reason).',
    { event: { type: 'string' }, param: { type: 'string' } }, ['event', 'param']],
  ['get_installs', 'New installs, uninstalls and net installs over the window.', {}, []],
  ['get_funnel', 'Distinct users at each step from first open to server connected and purchase.', {}, []]
].map(([name, description, properties, required]) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } }
}))

// Always returns a string no longer than MAX_RESULT_CHARS, never throws.
export function runTool(name, args, ctx) {
  const handler = handlers[name]
  if (!handler) return JSON.stringify({ error: `unknown tool ${name}` })
  let text
  try {
    text = JSON.stringify(handler(args ?? {}, ctx))
  } catch {
    return JSON.stringify({ error: 'tool failed' })
  }
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}...[truncated]` : text
}
