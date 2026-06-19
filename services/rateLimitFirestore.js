import { admin, db } from '../firebase.js'

const RL = 'rateLimits'

function todayStr() {
  return new Date().toISOString().split('T')[0] // YYYY-MM-DD UTC
}

function monthStr() {
  const d = new Date()
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

function nextUtcMidnight() {
  const d = new Date()
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1))
}

function firstDayNextMonth() {
  const d = new Date()
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))
}

async function fsIncrement(key, expiresAt) {
  const ref = db.collection(RL).doc(key)
  return db.runTransaction(async tx => {
    const doc = await tx.get(ref)
    if (!doc.exists || doc.data().expiresAt?.toDate() <= new Date()) {
      tx.set(ref, { count: 1, expiresAt: admin.firestore.Timestamp.fromDate(expiresAt) })
      return 1
    }
    const next = (doc.data().count ?? 0) + 1
    tx.update(ref, { count: next })
    return next
  })
}

async function fsGet(key) {
  const doc = await db.collection(RL).doc(key).get()
  if (!doc.exists) return 0
  if (doc.data().expiresAt?.toDate() <= new Date()) return 0
  return doc.data().count ?? 0
}

async function fsDecrement(key) {
  const ref = db.collection(RL).doc(key)
  return db.runTransaction(async tx => {
    const doc = await tx.get(ref)
    if (!doc.exists) return 0
    const next = Math.max(0, (doc.data().count ?? 0) - 1)
    tx.update(ref, { count: next })
    return next
  })
}

async function fsIncrementBy(key, amount, expiresAt) {
  const ref = db.collection(RL).doc(key)
  return db.runTransaction(async tx => {
    const doc = await tx.get(ref)
    if (!doc.exists || doc.data().expiresAt?.toDate() <= new Date()) {
      tx.set(ref, { count: amount, expiresAt: admin.firestore.Timestamp.fromDate(expiresAt) })
      return amount
    }
    const next = (doc.data().count ?? 0) + amount
    tx.update(ref, { count: next })
    return next
  })
}

// Daily request counter
export async function incrementDailyRequests(ptHash) {
  return fsIncrement(`${ptHash}_req_${todayStr()}`, nextUtcMidnight())
}
export async function getDailyRequests(ptHash) {
  return fsGet(`${ptHash}_req_${todayStr()}`)
}

// Daily token counter
export async function addDailyTokens(ptHash, amount) {
  return fsIncrementBy(`${ptHash}_tok_${todayStr()}`, amount, nextUtcMidnight())
}
export async function getDailyTokens(ptHash) {
  return fsGet(`${ptHash}_tok_${todayStr()}`)
}

// Monthly task counter
export async function incrementMonthlyTasks(ptHash) {
  return fsIncrement(`${ptHash}_tasks_${monthStr()}`, firstDayNextMonth())
}
export async function decrementMonthlyTasks(ptHash) {
  return fsDecrement(`${ptHash}_tasks_${monthStr()}`)
}
export async function getMonthlyTasks(ptHash) {
  return fsGet(`${ptHash}_tasks_${monthStr()}`)
}

// Helpers for retry_after / resetsAt values
export function secondsUntilMidnight() {
  return Math.floor((nextUtcMidnight() - Date.now()) / 1000)
}
export function resetsAtMidnight() {
  return nextUtcMidnight().toISOString()
}
export function resetsAtMonthStart() {
  return firstDayNextMonth().toISOString()
}
