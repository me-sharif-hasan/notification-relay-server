// In-memory store with the same contract as supportStore.js. Used by the tests
// and as the reference for what the Firestore store must do.
export function createMemoryStore({ now = Date.now } = {}) {
  const threads = new Map()
  const messages = new Map()
  const telegramMap = new Map()

  const key = (chatId, messageId) => `${chatId}:${messageId}`

  return {
    async getThread(installId) {
      const thread = threads.get(installId)
      return thread ? { ...thread, context: { ...thread.context } } : null
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
      threads.set(installId, thread)
      messages.set(installId, [])
      return { ...thread }
    },

    async updateThread(installId, patch) {
      const thread = threads.get(installId)
      if (!thread) return
      Object.assign(thread, patch, { updatedAt: now() })
    },

    async addMessage(installId, { from, text, kind, attachmentCount = 0 }) {
      const thread = threads.get(installId)
      const createdAt = now()
      thread.seq += 1
      thread.lastMessageAt = createdAt
      thread.updatedAt = createdAt
      if (from === 'user') thread.unreadForOwner += 1
      else thread.unreadForUser += 1
      const message = { seq: thread.seq, from, text, kind: kind ?? null, createdAt, attachmentCount }
      messages.get(installId).push(message)
      return { ...message }
    },

    async listMessages(installId, { after = 0, limit = 100 } = {}) {
      return (messages.get(installId) ?? []).filter(m => m.seq > after).slice(0, limit).map(m => ({ ...m }))
    },

    async markRead(installId, who) {
      const thread = threads.get(installId)
      if (!thread) return
      if (who === 'user') thread.unreadForUser = 0
      else thread.unreadForOwner = 0
    },

    async findByTopic(topicId) {
      for (const thread of threads.values()) if (thread.topicId === topicId) return { ...thread }
      return null
    },

    async mapTelegramMessage(chatId, messageId, installId) {
      telegramMap.set(key(chatId, messageId), installId)
    },

    async lookupTelegramMessage(chatId, messageId) {
      return telegramMap.get(key(chatId, messageId)) ?? null
    },

    async listOpenThreads(limit = 20) {
      return [...threads.values()]
        .filter(t => t.status === 'open')
        .sort((a, b) => b.lastMessageAt - a.lastMessageAt)
        .slice(0, limit)
        .map(t => ({ ...t }))
    },

    async listStale(beforeMs, limit = 200) {
      return [...threads.values()].filter(t => t.lastMessageAt < beforeMs).slice(0, limit).map(t => ({ ...t }))
    },

    async deleteThread(installId) {
      threads.delete(installId)
      messages.delete(installId)
      for (const [k, v] of telegramMap) if (v === installId) telegramMap.delete(k)
    }
  }
}
