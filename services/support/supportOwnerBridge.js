const GROUP_TYPES = ['group', 'supergroup']

const HELP = [
  'Support replies',
  '',
  'Write in a user topic to reply. Commands in a topic:',
  '/close  closes the thread (a new message reopens it)',
  '/block  stops the user from writing, /unblock undoes it',
  '/info  shows what the app sent',
  '',
  '/inbox  lists open threads',
  '/setup  (in the support group) connects the group'
].join('\n')

function age(ms, now) {
  const minutes = Math.max(0, Math.round((now - ms) / 60_000))
  if (minutes < 60) return `${minutes}m`
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`
  return `${Math.round(minutes / 1440)}d`
}

export function inboxText(threads, now) {
  if (threads.length === 0) return 'No open threads.'
  return threads
    .map(t => `#${t.shortId} ${t.country} | ${t.unreadForOwner} unread | ${age(t.lastMessageAt, now)} ago${t.forwardError ? ' | not forwarded' : ''}`)
    .join('\n')
}

export function infoText(thread) {
  const c = thread.context ?? {}
  return [
    `#${thread.shortId} | ${thread.country} | ${thread.status}${thread.blocked ? ' | blocked' : ''}`,
    `Messages: ${thread.seq} | Unread by you: ${thread.unreadForOwner}`,
    ...Object.entries(c).map(([k, v]) => `${k}: ${v}`)
  ].join('\n')
}

/**
 * Handles an update from the owner for the support flows. Returns true when
 * the update was consumed, false to let the existing bot handler look at it.
 */
export function createOwnerBridge({
  store,
  telegram,
  service,
  getSupportChatId,
  setSupportChatId,
  getOwnerId,
  now = Date.now
}) {
  async function reply(message, text) {
    return telegram.say(message.chat.id, message.message_thread_id ?? null, text)
  }

  async function setup(message) {
    const probe = await telegram.probeTopics(message.chat.id)
    if (!probe.ok) {
      await reply(message, `Topics are not ready (${probe.reason}). Turn on Topics in the group and make me an admin who can manage topics, then send /setup again.`)
      return
    }
    await setSupportChatId(message.chat.id)
    await reply(message, 'Support group connected. Each user now gets their own topic here.')
  }

  async function topicCommand(message, name, thread) {
    if (name === 'close') {
      await store.updateThread(thread.installId, { status: 'closed' })
      await telegram.closeTopic(message.chat.id, message.message_thread_id)
      return
    }
    if (name === 'block' || name === 'unblock') {
      await store.updateThread(thread.installId, { blocked: name === 'block' })
      await reply(message, name === 'block' ? 'Blocked. The user can no longer write.' : 'Unblocked.')
      return
    }
    if (name === 'info') await reply(message, infoText(thread))
  }

  async function answer(message, installId) {
    const { pushed } = await service.ownerReply(installId, message.text)
    if (!pushed.sent) {
      await reply(message, `Saved. No notification was sent (${pushed.reason}); the user sees it when they open the chat.`)
    }
  }

  async function fromGroup(message, supportChatId) {
    const text = message.text.trim()
    const command = /^\/(\w+)(?:@\w+)?/.exec(text)?.[1]
    if (command === 'setup') return setup(message)
    if (String(message.chat.id) !== String(supportChatId)) return
    if (command === 'inbox') return reply(message, inboxText(await store.listOpenThreads(), now()))
    if (command === 'help' || command === 'start') return reply(message, HELP)
    if (!message.message_thread_id) return reply(message, 'Write inside a user topic to reply to that user.')
    const thread = await store.findByTopic(message.message_thread_id)
    if (!thread) return reply(message, 'This topic is not linked to a user.')
    if (command) return topicCommand(message, command, thread)
    return answer(message, thread.installId)
  }

  async function fromPrivate(message) {
    const text = message.text.trim()
    if (/^\/inbox\b/.test(text)) {
      await reply(message, inboxText(await store.listOpenThreads(), now()))
      return true
    }
    const target = message.reply_to_message?.message_id
    if (!target || text.startsWith('/')) return false
    const installId = await store.lookupTelegramMessage(message.chat.id, target)
    if (!installId) return false
    await answer(message, installId)
    return true
  }

  return {
    async handleUpdate(update) {
      const message = update?.message
      if (!message?.text) return false
      const ownerId = String(await getOwnerId())
      if (GROUP_TYPES.includes(message.chat?.type)) {
        const supportChatId = await getSupportChatId()
        const isSetup = /^\/setup\b/.test(message.text.trim())
        const isSupportGroup = supportChatId && String(message.chat.id) === String(supportChatId)
        if (!isSetup && !isSupportGroup) return false
        if (!ownerId || String(message.from?.id) !== ownerId) return true
        await fromGroup(message, supportChatId)
        return true
      }
      if (message.chat?.type !== 'private') return false
      if (!ownerId || String(message.from?.id) !== ownerId) return false
      return fromPrivate(message)
    }
  }
}
