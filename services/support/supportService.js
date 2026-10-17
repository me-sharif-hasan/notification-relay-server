import {
  SupportError,
  contextSummary,
  createWindowLimiter,
  isInstallId,
  ownerMessageText,
  shortId,
  validateMessage
} from './supportLogic.js'

const LIST_LIMIT = 100

export function publicMessage(message) {
  return {
    id: message.seq,
    from: message.from,
    text: message.text,
    kind: message.kind ?? null,
    createdAt: message.createdAt,
    attachments: message.attachmentCount ?? 0
  }
}

export const LIMITS = {
  perMinute: 6,
  perDay: 1000,
  globalPerMinute: 300,
  imageMessagesPerDay: 60,
  globalImageMessagesPerMinute: 30,
  telegramForwardsPerHour: 60
}

export function createLimiters(now = Date.now) {
  return {
    minute: createWindowLimiter({ windowMs: 60_000, max: LIMITS.perMinute, now }),
    day: createWindowLimiter({ windowMs: 86_400_000, max: LIMITS.perDay, now }),
    global: createWindowLimiter({ windowMs: 60_000, max: LIMITS.globalPerMinute, now }),
    imageDay: createWindowLimiter({ windowMs: 86_400_000, max: LIMITS.imageMessagesPerDay, now }),
    imageGlobal: createWindowLimiter({ windowMs: 60_000, max: LIMITS.globalImageMessagesPerMinute, now }),
    forward: createWindowLimiter({ windowMs: 3_600_000, max: LIMITS.telegramForwardsPerHour, now })
  }
}

export function createSupportService({
  store,
  telegram,
  push,
  getSupportChatId = async () => null,
  deleteDeviceToken = async () => {},
  limiters = createLimiters()
}) {
  function checkLimits(installId, hasImages) {
    if (!limiters.global.take('all') || !limiters.minute.take(installId) || !limiters.day.take(installId)) {
      throw new SupportError(429, 'rate_limited')
    }
    if (hasImages && (!limiters.imageGlobal.take('all') || !limiters.imageDay.take(installId))) {
      throw new SupportError(429, 'rate_limited')
    }
  }

  async function openThread(installId, { kind, context, country }) {
    const existing = await store.getThread(installId)
    if (existing?.blocked) throw new SupportError(403, 'blocked')
    if (!existing) {
      return store.createThread(installId, { shortId: shortId(installId), country, kind, context })
    }
    const patch = {
      status: 'open',
      kind,
      context: { ...existing.context, ...context },
      country: country !== 'unknown' ? country : existing.country
    }
    await store.updateThread(installId, patch)
    if (existing.status === 'closed' && existing.topicId) await reopenTopic(existing).catch(() => {})
    return { ...existing, ...patch }
  }

  async function reopenTopic(thread) {
    const chatId = await getSupportChatId()
    if (chatId) await telegram.reopenTopic(chatId, thread.topicId)
  }

  const pending = new Set()

  async function forward(thread, validated) {
    // Everything is stored; only the Telegram copy is capped so one install cannot flood the chat.
    if (!limiters.forward.take(thread.installId)) return null
    const summary = contextSummary(validated.context)
    const topicText = [summary, summary ? '' : null, validated.text || '(images only)']
      .filter(line => line !== null)
      .join('\n')
    const ownerText = ownerMessageText({
      shortId: thread.shortId,
      country: thread.country,
      kind: validated.kind,
      text: validated.text,
      context: validated.context
    })
    try {
      return await telegram.deliver(thread, {
        kind: validated.kind,
        topicText,
        ownerText,
        images: validated.images,
        logs: validated.logs
      })
    } catch {
      return null
    }
  }

  return {
    async submitUserMessage(body, { country = 'unknown' } = {}) {
      // Limits first, so a flood of large bodies is refused before any image is decoded.
      if (isInstallId(body?.installId)) {
        checkLimits(body.installId, Array.isArray(body.images) && body.images.length > 0)
      }
      const validated = validateMessage(body)
      const thread = await openThread(validated.installId, { ...validated, country })
      const attachmentCount = validated.images.length + (validated.logs ? 1 : 0)
      const message = await store.addMessage(validated.installId, {
        from: 'user',
        text: validated.text,
        kind: validated.kind,
        attachmentCount
      })
      // The message is already stored, so the user is not kept waiting on Telegram.
      const delivery = forward(thread, validated)
        .then(delivered => store.updateThread(validated.installId, { forwardError: !delivered }))
        .catch(() => {})
        .finally(() => pending.delete(delivery))
      pending.add(delivery)
      return { message: publicMessage(message), delivered: true }
    },

    // Removes everything kept for one install: messages, the Telegram topic and the push token.
    async deleteConversation(installId) {
      const thread = await store.getThread(installId)
      if (!thread) return false
      const chatId = await getSupportChatId()
      if (chatId && thread.topicId) await telegram.deleteTopic(chatId, thread.topicId).catch(() => {})
      await store.deleteThread(installId)
      await deleteDeviceToken(installId).catch(() => {})
      return true
    },

    // Resolves when every background forward has finished (tests, shutdown).
    settled: () => Promise.all([...pending]),

    async listForUser(installId, { after = 0, markRead = false } = {}) {
      if (!isInstallId(installId)) throw new SupportError(400, 'invalid_install_id')
      const thread = await store.getThread(installId)
      if (!thread) return { messages: [], unread: 0 }
      const messages = await store.listMessages(installId, { after, limit: LIST_LIMIT })
      if (markRead && thread.unreadForUser > 0) await store.markRead(installId, 'user')
      return {
        messages: messages.map(publicMessage),
        unread: markRead ? 0 : thread.unreadForUser
      }
    },

    async unreadFor(installId) {
      if (!isInstallId(installId)) throw new SupportError(400, 'invalid_install_id')
      const thread = await store.getThread(installId)
      return { unread: thread?.unreadForUser ?? 0 }
    },

    async ownerReply(installId, text) {
      const thread = await store.getThread(installId)
      if (!thread) throw new SupportError(404, 'unknown_thread')
      const clean = String(text).trim().slice(0, 4000)
      if (!clean) throw new SupportError(400, 'empty_message')
      const message = await store.addMessage(installId, { from: 'owner', text: clean })
      const pushed = await push.notifyReply(installId, { text: clean, seq: message.seq })
      return { message: publicMessage(message), pushed }
    }
  }
}
