import { admin, db } from '../firebase.js'

// Aggregate counters only: no per-user record, token, IP or free text is stored.
const STATS_DOC = db.collection('surveyStats').doc('onboarding')

export const SURVEY_SOURCES = ['search', 'friend', 'youtube', 'reddit', 'social', 'other']
export const SURVEY_USES = ['admin', 'ssh', 'monitor', 'other']

// Returns { source, uses } with only whitelisted ids, or null if the body is
// malformed or carries no answer at all.
export function parseSurvey(body) {
  const { source = null, uses = [] } = body ?? {}
  if (source !== null && !SURVEY_SOURCES.includes(source)) return null
  if (!Array.isArray(uses) || uses.length > SURVEY_USES.length) return null
  if (!uses.every(u => SURVEY_USES.includes(u))) return null

  const unique = [...new Set(uses)]
  if (source === null && unique.length === 0) return null
  return { source, uses: unique }
}

export async function recordSurvey({ source, uses }) {
  const one = admin.firestore.FieldValue.increment(1)
  const sourceKey = source ?? 'none'
  const day = new Date().toISOString().slice(0, 10)

  const patch = {
    total: one,
    bySource: { [sourceKey]: one },
    byDay: { [day]: one },
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }
  // An empty map under merge would overwrite the stored one, so only add these when non-empty.
  if (uses.length) {
    patch.byUse = Object.fromEntries(uses.map(u => [u, one]))
    patch.byPair = Object.fromEntries(uses.map(u => [`${sourceKey}__${u}`, one]))
  }

  await STATS_DOC.set(patch, { merge: true })
}

export async function getSurveyStats() {
  const doc = await STATS_DOC.get()
  const d = doc.exists ? doc.data() : {}
  return {
    total: d.total ?? 0,
    bySource: d.bySource ?? {},
    byUse: d.byUse ?? {},
    byPair: d.byPair ?? {},
    byDay: d.byDay ?? {},
    updatedAt: d.updatedAt?.toDate?.()?.toISOString() ?? null
  }
}
