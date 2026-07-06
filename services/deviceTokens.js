import { admin, db } from '../firebase.js'

const DEVICE_TOKENS = 'deviceTokens'

// Single source of truth for "what FCM token does this install currently have".
// Keyed by installId (a stable, client-generated UUID) rather than sub or the
// integration-token hash, since neither of those is guaranteed stable across
// the life of an install (see BACKEND_PLAN.md).
export async function upsertDeviceToken(installId, { fcmToken, sub, plan, packageName }) {
  await db.collection(DEVICE_TOKENS).doc(installId).set({
    fcmToken,
    sub: sub ?? null,
    plan: plan ?? null,
    packageName: packageName ?? null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true })
}

export async function getDeviceFcmToken(installId) {
  if (!installId) return null
  const doc = await db.collection(DEVICE_TOKENS).doc(installId).get()
  return doc.exists ? doc.data().fcmToken ?? null : null
}

export async function getAllDeviceTokens() {
  const snap = await db.collection(DEVICE_TOKENS).get()
  return snap.docs.map(doc => ({ installId: doc.id, ...doc.data() }))
}

export async function getDeviceTokenCount() {
  const snap = await db.collection(DEVICE_TOKENS).count().get()
  return snap.data().count
}

export async function deleteDeviceToken(installId) {
  await db.collection(DEVICE_TOKENS).doc(installId).delete()
}
