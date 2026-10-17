const DAY_MS = 86_400_000

export function createRetention({ store, deleteConversation, days = 365, now = Date.now }) {
  return {
    // Removes conversations with no message for `days`, with their topics and push tokens.
    async sweep() {
      const cutoff = now() - days * DAY_MS
      const stale = await store.listStale(cutoff)
      for (const thread of stale) await deleteConversation(thread.installId)
      return stale.length
    }
  }
}

export function startRetention(sweep, { everyMs = DAY_MS, log = () => {} } = {}) {
  const run = () => sweep().then(count => count && log(count)).catch(() => {})
  setTimeout(run, 60_000).unref()
  setInterval(run, everyMs).unref()
}
