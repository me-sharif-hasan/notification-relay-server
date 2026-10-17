const DAY_MS = 86_400_000

export function createRetention({ store, telegram, getSupportChatId, days = 365, now = Date.now }) {
  return {
    // Removes threads with no message for `days`, and their Telegram topics.
    async sweep() {
      const cutoff = now() - days * DAY_MS
      const stale = await store.listStale(cutoff)
      if (stale.length === 0) return 0
      const chatId = await getSupportChatId()
      for (const thread of stale) {
        if (chatId && thread.topicId) await telegram.deleteTopic(chatId, thread.topicId).catch(() => {})
        await store.deleteThread(thread.installId)
      }
      return stale.length
    }
  }
}

export function startRetention(sweep, { everyMs = DAY_MS, log = () => {} } = {}) {
  const run = () => sweep().then(count => count && log(count)).catch(() => {})
  setTimeout(run, 60_000).unref()
  setInterval(run, everyMs).unref()
}
