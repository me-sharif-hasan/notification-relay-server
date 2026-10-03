import { admin, db } from '../firebase.js'

// Lifetime counters plus one row per install. A row holds only the answers,
// a day, and a coarse location from Cloudflare headers: no IP, token or free
// text. Rows carry expiresAt so a Firestore TTL policy can prune them.
const STATS_DOC = db.collection('surveyStats').doc('onboarding')
const RESPONSES = db.collection('surveyResponses')

const ROW_TTL_MS = 180 * 86_400_000
const TODAY_ROW_LIMIT = 5000

export const SURVEY_SOURCES = ['search', 'friend', 'youtube', 'reddit', 'social', 'other']
export const SURVEY_USES = ['admin', 'ssh', 'monitor', 'other']

// Returns { source, uses } with only whitelisted ids, or null if the body is
// malformed. An empty answer is valid: it still marks the install.
export function parseSurvey(body) {
  const { source = null, uses = [] } = body ?? {}
  if (source !== null && !SURVEY_SOURCES.includes(source)) return null
  if (!Array.isArray(uses) || uses.length > SURVEY_USES.length) return null
  if (!uses.every(u => SURVEY_USES.includes(u))) return null

  return { source, uses: [...new Set(uses)] }
}

// ISO country code from Cloudflare's CF-IPCountry header, or 'unknown'
// (missing header, XX = unknown, T1 = Tor). The IP itself is never read here.
export function parseCountry(headerValue) {
  const code = typeof headerValue === 'string' ? headerValue.trim().toUpperCase() : ''
  return /^[A-Z]{2}$/.test(code) && code !== 'XX' && code !== 'T1' ? code : 'unknown'
}

// City or region name from Cloudflare's optional location headers.
export function parsePlace(headerValue) {
  if (typeof headerValue !== 'string') return null
  const clean = headerValue.replace(/[^\p{L}\p{N} .'\-]/gu, '').trim().slice(0, 64)
  return clean || null
}

function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

export async function recordSurvey({ source, uses, country = 'unknown', region = null, city = null }) {
  const one = admin.firestore.FieldValue.increment(1)
  const sourceKey = source ?? 'none'
  const day = todayStr()

  const patch = {
    total: one,
    bySource: { [sourceKey]: one },
    byCountry: { [country]: one },
    byDay: { [day]: one },
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }
  // An empty map under merge would overwrite the stored one, so only add these when non-empty.
  if (uses.length) {
    patch.byUse = Object.fromEntries(uses.map(u => [u, one]))
    patch.byPair = Object.fromEntries(uses.map(u => [`${sourceKey}__${u}`, one]))
  }

  const row = {
    day,
    source: sourceKey,
    uses,
    country,
    region,
    city,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    expiresAt: new Date(Date.now() + ROW_TTL_MS)
  }

  const batch = db.batch()
  batch.set(STATS_DOC, patch, { merge: true })
  batch.set(RESPONSES.doc(), row)
  await batch.commit()
}

export async function getSurveyStats() {
  const doc = await STATS_DOC.get()
  const d = doc.exists ? doc.data() : {}
  return {
    total: d.total ?? 0,
    bySource: d.bySource ?? {},
    byUse: d.byUse ?? {},
    byPair: d.byPair ?? {},
    byCountry: d.byCountry ?? {},
    byDay: d.byDay ?? {},
    updatedAt: d.updatedAt?.toDate?.()?.toISOString() ?? null
  }
}

export async function getTodayCount() {
  const snap = await RESPONSES.where('day', '==', todayStr()).count().get()
  return snap.data().count
}

export async function getTodayStats() {
  const day = todayStr()
  const snap = await RESPONSES.where('day', '==', day).limit(TODAY_ROW_LIMIT).get()
  const byCountry = {}
  const bySource = {}
  for (const doc of snap.docs) {
    const { country = 'unknown', source = 'none' } = doc.data()
    byCountry[country] = (byCountry[country] ?? 0) + 1
    bySource[source] = (bySource[source] ?? 0) + 1
  }
  return { day, total: snap.size, byCountry, bySource, capped: snap.size >= TODAY_ROW_LIMIT }
}

export async function getRecentResponses(limit = 50) {
  const snap = await RESPONSES.orderBy('createdAt', 'desc').limit(limit).get()
  return snap.docs.map(doc => {
    const d = doc.data()
    return {
      time: d.createdAt?.toDate?.()?.toISOString() ?? null,
      source: d.source ?? 'none',
      uses: Array.isArray(d.uses) ? d.uses : [],
      country: d.country ?? 'unknown',
      region: d.region ?? null,
      city: d.city ?? null
    }
  })
}
