import { FEATURE_PREFIXES, FUNNEL_STEPS, isTrackedParam } from './constants.js'

const MAX_VALUES_PER_PARAM = 25
const MAX_PARAMS_PER_EVENT = 8
const OTHER = '(other)'

function clean(value) {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase().slice(0, 40) : null
}

// Which product feature an event belongs to, or null for non-feature events.
export function featureOf(name, params) {
  if (name === 'feature_open') return clean(params.feature_name)
  if (name === 'feature_action') return clean(params.feature)
  if (name === 'lab_tool_opened') return clean(params.tool_name) ?? 'labs'
  for (const [prefix, feature] of FEATURE_PREFIXES) {
    if (name.startsWith(prefix)) return feature
  }
  return null
}

function bump(map, key, by = 1) {
  map.set(key, (map.get(key) ?? 0) + by)
}

function entryFor(map, key, size) {
  let entry = map.get(key)
  if (!entry) {
    entry = { total: 0, users: new Set(), latestUsers: new Set(), daily: new Array(size).fill(0) }
    map.set(key, entry)
  }
  return entry
}

// One pass over the events of a window. `days` is the ordered list of dates
// in the window, so every series is zero-filled and aligned with it.
export function createCollector(days) {
  const size = days.length
  const index = new Map(days.map((d, i) => [d, i]))
  const events = new Map()
  const features = new Map()
  const params = new Map()
  const dayUsers = days.map(() => new Set())
  const daily = { events: new Array(size).fill(0), sessions: new Array(size).fill(0), newInstalls: new Array(size).fill(0), uninstalls: new Array(size).fill(0) }
  const allUsers = new Set()
  const versions = new Map()
  const countries = new Map()

  function addParams(name, p) {
    let byKey = params.get(name)
    for (const [key, raw] of Object.entries(p)) {
      const value = clean(String(raw ?? ''))
      if (!value || !isTrackedParam(key)) continue
      if (!byKey) params.set(name, byKey = new Map())
      let values = byKey.get(key)
      if (!values) {
        if (byKey.size >= MAX_PARAMS_PER_EVENT) continue
        byKey.set(key, values = new Map())
      }
      bump(values, values.has(value) || values.size < MAX_VALUES_PER_PARAM ? value : OTHER)
    }
  }

  return {
    add(day, ev) {
      const i = index.get(day)
      if (i === undefined || !ev.name || ev.params.debug_event) return

      daily.events[i]++
      if (ev.uid) {
        dayUsers[i].add(ev.uid)
        allUsers.add(ev.uid)
      }
      if (ev.name === 'session_start') daily.sessions[i]++
      if (ev.name === 'first_open') daily.newInstalls[i]++
      if (ev.name === 'app_remove') daily.uninstalls[i]++

      const entry = entryFor(events, ev.name, size)
      entry.total++
      entry.daily[i]++
      if (ev.uid) {
        entry.users.add(ev.uid)
        if (i === size - 1) entry.latestUsers.add(ev.uid)
      }
      addParams(ev.name, ev.params)

      const feature = featureOf(ev.name, ev.params)
      if (feature) {
        const f = entryFor(features, feature, size)
        f.total++
        f.daily[i]++
        if (ev.uid) f.users.add(ev.uid)
      }

      if (ev.uid && ev.version) (versions.get(ev.version) ?? versions.set(ev.version, new Set()).get(ev.version)).add(ev.uid)
      if (ev.uid && ev.country && ev.country !== '(not set)') (countries.get(ev.country) ?? countries.set(ev.country, new Set()).get(ev.country)).add(ev.uid)
    },

    finish() {
      const sum = values => values.reduce((a, b) => a + b, 0)
      const plain = map => Object.fromEntries([...map].map(([k, e]) => [k, { total: e.total, users: e.users.size, latestUsers: e.latestUsers.size, daily: e.daily }]))
      const sizes = map => Object.fromEntries([...map].map(([k, set]) => [k, set.size]))
      const objectify = map => Object.fromEntries([...map].map(([k, v]) => [k, Object.fromEntries(v)]))

      const eventsOut = plain(events)
      return {
        days,
        totals: {
          events: sum(daily.events),
          users: allUsers.size,
          sessions: sum(daily.sessions),
          newInstalls: sum(daily.newInstalls),
          uninstalls: sum(daily.uninstalls)
        },
        daily: { ...daily, users: dayUsers.map(s => s.size) },
        events: eventsOut,
        features: plain(features),
        params: Object.fromEntries([...params].map(([name, byKey]) => [name, objectify(byKey)])),
        funnel: Object.fromEntries(FUNNEL_STEPS.filter(s => events.has(s)).map(s => [s, events.get(s).users.size])),
        versions: sizes(versions),
        countries: sizes(countries)
      }
    }
  }
}

// Known features with no usage. A feature counts as used when any recorded
// name is it or a sub-feature of it (rdbms_dashboard counts for rdbms).
export function unusedFeatures(stats, known) {
  const used = Object.keys(stats.features)
  return known.filter(f => !used.some(name => name === f || name.startsWith(`${f}_`)))
}

// Change of the second half of a series against its first half, in percent.
export function halfChange(daily) {
  const mid = Math.floor(daily.length / 2)
  if (mid < 2) return null
  const first = daily.slice(0, mid).reduce((a, b) => a + b, 0)
  const second = daily.slice(daily.length - mid).reduce((a, b) => a + b, 0)
  return first === 0 ? null : Math.round(((second - first) / first) * 100)
}
