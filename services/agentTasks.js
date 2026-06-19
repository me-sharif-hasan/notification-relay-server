import { randomBytes } from 'crypto'
import { admin, db } from '../firebase.js'

const AGENT_TASKS = 'agentTasks'

export function generateTaskId() {
  return 'tsk_' + randomBytes(6).toString('hex')
}

export async function createTask(taskId, ptHash, description) {
  await db.collection(AGENT_TASKS).doc(taskId).set({
    ptHash,
    startedAt: admin.firestore.FieldValue.serverTimestamp(),
    firstLlmCall: null,
    description: description ?? null
  })
}

export async function getTask(taskId) {
  const doc = await db.collection(AGENT_TASKS).doc(taskId).get()
  if (!doc.exists) return null
  return { taskId, ...doc.data() }
}

// Atomically marks firstLlmCall on the first LLM call for a task.
// Returns true if this was the first call (counter should be incremented),
// false if already marked (subsequent step — skip counter).
export async function claimFirstLlmCall(taskId) {
  const ref = db.collection(AGENT_TASKS).doc(taskId)
  let isFirst = false
  await db.runTransaction(async tx => {
    const doc = await tx.get(ref)
    if (!doc.exists) throw new Error('task_not_found')
    if (doc.data().firstLlmCall == null) {
      tx.update(ref, { firstLlmCall: admin.firestore.FieldValue.serverTimestamp() })
      isFirst = true
    }
  })
  return isFirst
}
