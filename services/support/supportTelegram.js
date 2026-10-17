import { getEnv } from '../../config.js'
import { topicTitle } from './supportLogic.js'

const API = 'https://api.telegram.org'
const TIMEOUT_MS = 20_000
const KIND_TAG = { idea: '[Idea] ', question: '[Question] ' }

function toForm(payload, file) {
  const form = new FormData()
  for (const [name, value] of Object.entries(payload)) form.append(name, String(value))
  if (file) form.append(file.field, new Blob([file.buffer], { type: file.mime }), file.name)
  return form
}

// Never throws and never includes the request URL, which holds the bot token.
export async function telegramCall(method, payload, file) {
  const token = getEnv('TELEGRAM_BOT_TOKEN')
  if (!token) return { ok: false, description: 'not_configured' }
  try {
    const res = await fetch(`${API}/bot${token}/${method}`, {
      method: 'POST',
      ...(file
        ? { body: toForm(payload, file) }
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    const json = await res.json().catch(() => ({}))
    return { ok: Boolean(json.ok), result: json.result, description: json.description ?? `http_${res.status}` }
  } catch {
    return { ok: false, description: 'network' }
  }
}

const threadGone = description => /thread not found|TOPIC_ID_INVALID|TOPIC_DELETED/i.test(String(description))

export function createSupportTelegram({ call = telegramCall, store, getSupportChatId, getOwnerChatId }) {
  async function createTopic(chatId, thread) {
    const created = await call('createForumTopic', { chat_id: chatId, name: topicTitle(thread) })
    return created.ok ? created.result.message_thread_id : null
  }

  async function ensureTopic(chatId, thread, { fresh = false } = {}) {
    if (thread.topicId && !fresh) return thread.topicId
    const topicId = await createTopic(chatId, thread)
    if (topicId) {
      await store.updateThread(thread.installId, { topicId })
      thread.topicId = topicId
    }
    return topicId
  }

  async function sendOne(chatId, topicId, method, payload, file) {
    const base = { chat_id: chatId, ...(topicId ? { message_thread_id: topicId } : {}), ...payload }
    return call(method, base, file)
  }

  async function sendAll(chatId, topicId, { text, images, logs }, afterSend) {
    const sent = await sendOne(chatId, topicId, 'sendMessage', { text })
    if (!sent.ok) return sent
    await afterSend?.(sent.result.message_id)
    for (const image of images) {
      let shown = await sendOne(chatId, topicId, 'sendPhoto', {}, { ...image, field: 'photo' })
      // Telegram refuses photos with extreme proportions; a file keeps the screenshot readable.
      if (!shown.ok) shown = await sendOne(chatId, topicId, 'sendDocument', {}, { ...image, field: 'document' })
      if (shown.ok) await afterSend?.(shown.result.message_id)
    }
    if (logs) {
      const buffer = Buffer.from(logs, 'utf8')
      const doc = await sendOne(chatId, topicId, 'sendDocument', {}, {
        field: 'document', buffer, name: 'diagnostics.txt', mime: 'text/plain'
      })
      if (doc.ok) await afterSend?.(doc.result.message_id)
    }
    return sent
  }

  async function deliverToTopic(chatId, thread, content) {
    let topicId = await ensureTopic(chatId, thread)
    if (!topicId) return null
    const text = `${KIND_TAG[content.kind] ?? ''}${content.topicText}`
    let sent = await sendAll(chatId, topicId, { ...content, text })
    if (!sent.ok && threadGone(sent.description)) {
      topicId = await ensureTopic(chatId, thread, { fresh: true })
      if (!topicId) return null
      sent = await sendAll(chatId, topicId, { ...content, text })
    }
    return sent.ok ? { route: 'topic', topicId } : null
  }

  async function deliverToOwner(thread, content) {
    const ownerChatId = await getOwnerChatId()
    if (!ownerChatId) return null
    const sent = await sendAll(
      ownerChatId,
      null,
      { ...content, text: content.ownerText },
      messageId => store.mapTelegramMessage(ownerChatId, messageId, thread.installId)
    )
    return sent.ok ? { route: 'owner' } : null
  }

  return {
    // Topic in the support group when there is one; the owner chat otherwise.
    async deliver(thread, content) {
      const chatId = await getSupportChatId()
      const viaTopic = chatId ? await deliverToTopic(chatId, thread, { images: [], logs: '', ...content }) : null
      if (viaTopic) return viaTopic
      return deliverToOwner(thread, { images: [], logs: '', ...content })
    },

    async say(chatId, topicId, text) {
      return sendOne(chatId, topicId, 'sendMessage', { text })
    },

    async closeTopic(chatId, topicId) {
      return call('closeForumTopic', { chat_id: chatId, message_thread_id: topicId })
    },

    async reopenTopic(chatId, topicId) {
      return call('reopenForumTopic', { chat_id: chatId, message_thread_id: topicId })
    },

    async deleteTopic(chatId, topicId) {
      return call('deleteForumTopic', { chat_id: chatId, message_thread_id: topicId })
    },

    // Proves Topics are on and the bot may manage them, then removes the probe.
    async probeTopics(chatId) {
      const created = await call('createForumTopic', { chat_id: chatId, name: 'Setup check' })
      if (!created.ok) return { ok: false, reason: created.description }
      await call('deleteForumTopic', { chat_id: chatId, message_thread_id: created.result.message_thread_id })
      return { ok: true }
    }
  }
}
