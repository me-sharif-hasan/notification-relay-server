import { admin, db } from '../../firebase.js'

const THREADS = 'supportThreads'
const MESSAGES = 'messages'
const TELEGRAM_MAP = 'supportTelegramMap'
const BATCH = 400

const threads = () => db.collection(THREADS)
const pad = seq => String(seq).padStart(8, '0')
const mapKey = (chatId, messageId) => `${chatId}_${messageId}`

export function createFirestoreStore({ now = Date.now } = {}) {
  return {
    async getThread(installId) {
      const doc = await threads().doc(installId).get()
      return doc.exists ? doc.data() : null
    },

    async createThread(installId, data) {
      const t = now()
      const thread = {
        installId,
        status: 'open',
        blocked: false,
        country: 'unknown',
        topicId: null,
        kind: 'problem',
        context: {},
        seq: 0,
        unreadForUser: 0,
        unreadForOwner: 0,
        createdAt: t,
        updatedAt: t,
        lastMessageAt: t,
        ...data
      }
      await threads().doc(installId).set(thread)
      return thread
    },

    async updateThread(installId, patch) {
      await threads().doc(installId).update({ ...patch, updatedAt: now() })
    },

    async addMessage(installId, { from, text, kind, attachmentCount = 0 }) {
      const ref = threads().doc(installId)
      return db.runTransaction(async tx => {
        const snap = await tx.get(ref)
        const seq = (snap.data().seq ?? 0) + 1
        const createdAt = now()
        const counter = from === 'user' ? 'unreadForOwner' : 'unreadForUser'
        const message = { seq, from, text, kind: kind ?? null, createdAt, attachmentCount }
        tx.update(ref, {
          seq,
          lastMessageAt: createdAt,
          updatedAt: createdAt,
          [counter]: admin.firestore.FieldValue.increment(1)
        })
        tx.set(ref.collection(MESSAGES).doc(pad(seq)), message)
        return message
      })
    },

    async listMessages(installId, { after = 0, limit = 100 } = {}) {
      const snap = await threads()
        .doc(installId)
        .collection(MESSAGES)
        .where('seq', '>', after)
        .orderBy('seq')
        .limit(limit)
        .get()
      return snap.docs.map(doc => doc.data())
    },

    async markRead(installId, who) {
      const field = who === 'user' ? 'unreadForUser' : 'unreadForOwner'
      await threads().doc(installId).update({ [field]: 0 })
    },

    async findByTopic(topicId) {
      const snap = await threads().where('topicId', '==', topicId).limit(1).get()
      return snap.empty ? null : snap.docs[0].data()
    },

    async mapTelegramMessage(chatId, messageId, installId) {
      await db.collection(TELEGRAM_MAP).doc(mapKey(chatId, messageId)).set({ installId, createdAt: now() })
    },

    async lookupTelegramMessage(chatId, messageId) {
      const doc = await db.collection(TELEGRAM_MAP).doc(mapKey(chatId, messageId)).get()
      return doc.exists ? doc.data().installId : null
    },

    async listOpenThreads(limit = 20) {
      const snap = await threads().where('status', '==', 'open').limit(200).get()
      return snap.docs
        .map(doc => doc.data())
        .sort((a, b) => b.lastMessageAt - a.lastMessageAt)
        .slice(0, limit)
    },

    async listStale(beforeMs, limit = 200) {
      const snap = await threads().where('lastMessageAt', '<', beforeMs).limit(limit).get()
      return snap.docs.map(doc => doc.data())
    },

    async deleteThread(installId) {
      const ref = threads().doc(installId)
      for (;;) {
        const snap = await ref.collection(MESSAGES).limit(BATCH).get()
        if (snap.empty) break
        const batch = db.batch()
        snap.docs.forEach(doc => batch.delete(doc.ref))
        await batch.commit()
      }
      const mapped = await db.collection(TELEGRAM_MAP).where('installId', '==', installId).limit(BATCH).get()
      const batch = db.batch()
      mapped.docs.forEach(doc => batch.delete(doc.ref))
      batch.delete(ref)
      await batch.commit()
    }
  }
}
