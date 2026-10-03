import { createHash } from 'crypto'
import { verifyIntegrityToken, checkVerdicts } from '../auth/integrity.js'
import { getEnv } from '../config.js'
import { parseSurvey, recordSurvey } from '../services/surveyStats.js'

const FRESH_MS = 10 * 60_000
const MAX_PER_MIN = 300

// In memory only, cleared on restart: spent integrity tokens (replay guard)
// and a global per-minute cap. Nothing here is shared with /alert's limiter.
const spentTokens = new Map()
let windowStart = 0
let windowCount = 0

function overGlobalLimit(now) {
  if (now - windowStart >= 60_000) {
    windowStart = now
    windowCount = 0
  }
  return ++windowCount > MAX_PER_MIN
}

function claimToken(tokenHash, now) {
  for (const [key, expiresAt] of spentTokens) {
    if (expiresAt <= now) spentTokens.delete(key)
  }
  if (spentTokens.has(tokenHash)) return false
  spentTokens.set(tokenHash, now + FRESH_MS)
  return true
}

export async function surveyRoutes(app) {
  // POST /survey - anonymous onboarding answers. Authenticated by a fresh,
  // single-use Play Integrity token, not by a JWT, so free users can send it
  // too. Only aggregate counters are stored. 'warn' keeps the per-request
  // access log (which would include the client IP) out of the logs.
  app.post('/survey', { logLevel: 'warn' }, async (request, reply) => {
    const { integrityToken, packageName } = request.body ?? {}
    const survey = parseSurvey(request.body)
    if (!survey || typeof integrityToken !== 'string' || typeof packageName !== 'string') {
      return reply.code(400).send({ success: false, error: 'invalid_request' })
    }

    const expectedPackage = getEnv('GOOGLE_PLAY_PACKAGE_NAME')
    if (packageName.endsWith('.debug') || (expectedPackage && packageName !== expectedPackage)) {
      return reply.code(403).send({ success: false, error: 'package_not_allowed' })
    }

    const now = Date.now()
    if (overGlobalLimit(now)) {
      return reply.code(429).send({ success: false, error: 'rate_limited' })
    }

    const tokenHash = createHash('sha256').update(integrityToken).digest('hex')
    if (!claimToken(tokenHash, now)) {
      return reply.code(409).send({ success: false, error: 'token_already_used' })
    }

    let verdict
    try {
      verdict = await verifyIntegrityToken(integrityToken, packageName)
    } catch (err) {
      request.log.warn({ err: err.message }, 'survey integrity verify failed')
      return reply.code(401).send({ success: false, error: 'integrity_unverified' })
    }

    if (!checkVerdicts(verdict).ok) {
      return reply.code(403).send({ success: false, error: 'integrity_failed' })
    }

    const issuedAt = Number(verdict?.tokenPayloadExternal?.requestDetails?.timestampMillis)
    if (!Number.isFinite(issuedAt) || now - issuedAt > FRESH_MS) {
      return reply.code(400).send({ success: false, error: 'stale_token' })
    }

    try {
      await recordSurvey(survey)
    } catch (err) {
      request.log.error({ err: err.message }, 'survey write failed')
      return reply.code(500).send({ success: false, error: 'write_failed' })
    }

    return { success: true }
  })
}
