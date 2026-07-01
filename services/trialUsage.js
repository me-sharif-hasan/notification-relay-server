'use strict'
import { admin, db } from '../firebase.js'

const COL = 'trialUsage'

/**
 * @param {string} identity
 * @param {number} windowDays
 * @returns {Promise<{ used: number, resetsAt: Date|null, expired: boolean }>}
 */
export async function getTrialStatus(identity, windowDays) {
  const doc = await db.collection(COL).doc(identity).get()
  if (!doc.exists) return { used: 0, resetsAt: null, expired: true }

  const data = doc.data()
  const windowStart = data.windowStart?.toDate?.() ?? null
  const windowMs    = windowDays * 24 * 60 * 60 * 1000
  const now         = Date.now()

  if (!windowStart || now >= windowStart.getTime() + windowMs) {
    return { used: 0, resetsAt: null, expired: true }
  }

  return {
    used:     data.promptsUsed ?? 0,
    resetsAt: new Date(windowStart.getTime() + windowMs),
    expired:  false,
  }
}

/**
 * Atomically increments the trial counter. Resets the window when expired.
 * @returns {Promise<{ used: number, resetsAt: Date }>}
 */
export async function incrementTrialPrompts(identity, windowDays) {
  const ref      = db.collection(COL).doc(identity)
  const windowMs = windowDays * 24 * 60 * 60 * 1000
  const now      = new Date()

  return db.runTransaction(async tx => {
    const doc = await tx.get(ref)

    if (!doc.exists) {
      tx.set(ref, {
        promptsUsed: 1,
        windowStart: admin.firestore.Timestamp.fromDate(now),
      })
      return { used: 1, resetsAt: new Date(now.getTime() + windowMs) }
    }

    const data        = doc.data()
    const windowStart = data.windowStart?.toDate?.() ?? null
    const expired     = !windowStart || now.getTime() >= windowStart.getTime() + windowMs

    if (expired) {
      tx.set(ref, {
        promptsUsed: 1,
        windowStart: admin.firestore.Timestamp.fromDate(now),
      })
      return { used: 1, resetsAt: new Date(now.getTime() + windowMs) }
    }

    const next = (data.promptsUsed ?? 0) + 1
    tx.update(ref, { promptsUsed: next })
    return { used: next, resetsAt: new Date(windowStart.getTime() + windowMs) }
  })
}

/** Wipe a user's trial so they start fresh (admin action). */
export async function resetTrial(identity) {
  await db.collection(COL).doc(identity).delete()
}

/** Returns all trial records for the admin dashboard. */
export async function getAllTrialUsers() {
  const snap = await db.collection(COL).get()
  return snap.docs.map(doc => {
    const d = doc.data()
    return {
      identity:    doc.id,
      promptsUsed: d.promptsUsed ?? 0,
      windowStart: d.windowStart?.toDate?.()?.toISOString() ?? null,
    }
  })
}
