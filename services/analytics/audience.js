import { getEnv } from '../../config.js'

const US = 'United States'
const DEFAULT_US_CAP = 15

export function usUserCap() {
  const cap = Number(getEnv('ANALYTICS_US_USER_CAP'))
  return Number.isInteger(cap) && cap > 0 ? cap : DEFAULT_US_CAP
}

const hasCountry = country => Boolean(country) && country !== '(not set)'

// First pass over a window, reading only user and country. It decides who is
// part of the analysis:
//  - users never seen with a country are left out (bots, emulators, devices
//    with no location);
//  - at most `usCap` US users are kept, and they are the quietest ones, because
//    a release brings heavy automated US test devices that look like a spike.
export function createAudienceScan(usCap = usUserCap()) {
  const everyone = new Set()
  const located = new Set()
  const usEvents = new Map()

  return {
    add(ev) {
      if (!ev.uid) return
      everyone.add(ev.uid)
      if (!hasCountry(ev.country)) return
      located.add(ev.uid)
      if (ev.country === US) usEvents.set(ev.uid, (usEvents.get(ev.uid) ?? 0) + 1)
    },

    finish() {
      const quietest = [...usEvents]
        .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, usCap)
        .map(([uid]) => uid)
      const keptUs = new Set(quietest)

      return {
        usCap,
        noCountryUsers: everyone.size - located.size,
        droppedUsUsers: usEvents.size - keptUs.size,
        // An event without a user id can only be judged on its own country.
        allows: ev => (ev.uid
          ? located.has(ev.uid) && (!usEvents.has(ev.uid) || keptUs.has(ev.uid))
          : hasCountry(ev.country) && ev.country !== US)
      }
    }
  }
}
