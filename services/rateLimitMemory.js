const rateLimits = new Map()

// Returns { limited: false } or { limited: true, retryAfter: seconds }
export function checkRateLimit(key, maxPerMin = 10) {
  const now = Date.now()
  const entry = rateLimits.get(key)
  if (!entry || now > entry.resetAt) {
    rateLimits.set(key, { count: 1, resetAt: now + 60_000 })
    return { limited: false }
  }
  if (entry.count >= maxPerMin) {
    return { limited: true, retryAfter: Math.ceil((entry.resetAt - now) / 1000) }
  }
  entry.count++
  return { limited: false }
}

// Simple boolean form — kept for alert route compatibility
export function isRateLimited(key, maxPerMin = 10) {
  return checkRateLimit(key, maxPerMin).limited
}

// Returns { [key]: { count, resetAt } } for all non-expired entries
export function getPerMinuteSnapshot() {
  const now = Date.now()
  const out = {}
  for (const [key, entry] of rateLimits) {
    if (now <= entry.resetAt) out[key] = { count: entry.count, resetsIn: Math.ceil((entry.resetAt - now) / 1000) }
  }
  return out
}
