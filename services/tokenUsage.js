import { admin, db } from '../firebase.js'

function todayKey(deviceId) {
  const date = new Date().toISOString().split('T')[0]
  return `${deviceId}_${date}`
}

export async function getDailyTokens(deviceId) {
  const doc = await db.collection('tokenUsage').doc(todayKey(deviceId)).get()
  return doc.exists ? (doc.data().tokens ?? 0) : 0
}

export async function addTokens(deviceId, count) {
  if (!deviceId || !count) return
  const key = todayKey(deviceId)
  await db.collection('tokenUsage').doc(key).set(
    {
      tokens: admin.firestore.FieldValue.increment(count),
      deviceId,
      date: key.split('_')[1]
    },
    { merge: true }
  )
}
