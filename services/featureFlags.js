import { admin, db } from '../firebase.js'

const FEATURE_FLAGS = 'featureFlags'
const CAMEL_CASE = /^[a-z][a-zA-Z0-9]*$/

// Pre-seeded so they show up (toggleable) in the admin panel before anyone
// has explicitly set a value. Any other camelCase key can still be added
// dynamically via POST /admin/features/set — this list is just a head start,
// not a restriction.
export const KNOWN_FEATURE_KEYS = ['interstitialAd', 'bannerAd', 'showAiAgent']

export function isValidFeatureKey(key) {
  return typeof key === 'string' && CAMEL_CASE.test(key)
}

export async function getAllFeatureFlags() {
  const snap = await db.collection(FEATURE_FLAGS).get()
  const flags = {}
  for (const key of KNOWN_FEATURE_KEYS) flags[key] = false
  for (const doc of snap.docs) flags[doc.id] = !!doc.data().enabled
  return flags
}

export async function getFeatureFlag(key) {
  const doc = await db.collection(FEATURE_FLAGS).doc(key).get()
  return doc.exists ? !!doc.data().enabled : false
}

export async function setFeatureFlag(key, enabled) {
  await db.collection(FEATURE_FLAGS).doc(key).set({
    enabled: !!enabled,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true })
}

export async function deleteFeatureFlag(key) {
  await db.collection(FEATURE_FLAGS).doc(key).delete()
}
