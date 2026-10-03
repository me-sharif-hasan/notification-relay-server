export const MAX_MUTE_MINUTES = 10080

function toDate(value) {
  if (!value) return null
  if (typeof value.toDate === 'function') return value.toDate()
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * Validates a mute request body. Returns { mutedUntil, mutedIndefinitely } to
 * store, or { error } when the request is malformed.
 */
export function parseMuteRequest(body, now = new Date()) {
  if (body?.indefinite === true) {
    return { mutedUntil: null, mutedIndefinitely: true }
  }
  const minutes = body?.minutes
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MUTE_MINUTES) {
    return { error: `minutes must be a whole number from 1 to ${MAX_MUTE_MINUTES}, or indefinite must be true` }
  }
  return { mutedUntil: new Date(now.getTime() + minutes * 60_000), mutedIndefinitely: false }
}

/** The mute state of a token document; an elapsed mute counts as not muted. */
export function muteStatus(data, now = new Date()) {
  if (data?.mutedIndefinitely === true) {
    return { muted: true, indefinite: true, until: null }
  }
  const until = toDate(data?.mutedUntil)
  if (until && until.getTime() > now.getTime()) {
    return { muted: true, indefinite: false, until: until.toISOString() }
  }
  return { muted: false, indefinite: false, until: null }
}
