import { admin, db } from '../firebase.js'

const BLOCKLIST = 'blocklist'

export async function isBlocklisted(ptHash) {
  const doc = await db.collection(BLOCKLIST).doc(ptHash).get()
  return doc.exists
}

export async function addToBlocklist(ptHash) {
  await db.collection(BLOCKLIST).doc(ptHash).set({
    blockedAt: admin.firestore.FieldValue.serverTimestamp()
  })
}

export async function removeFromBlocklist(ptHash) {
  await db.collection(BLOCKLIST).doc(ptHash).delete()
}
