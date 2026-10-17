import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryStore } from './supportMemoryStore.js'
import { createSupportTelegram } from './supportTelegram.js'
import { createSupportPush, buildReplyMessage, SUPPORT_CHANNEL } from './supportPush.js'

const ID = '3f2b8c1e-5a47-4d6e-9b0a-1c2d3e4f5a6b'

function setup({ supportChatId = '-100', ownerChatId = '42', respond } = {}) {
  const store = createMemoryStore()
  const calls = []
  let nextMessageId = 100
  const call = async (method, payload, file) => {
    calls.push({ method, payload, file })
    const custom = respond?.(method, payload, calls)
    if (custom) return custom
    if (method === 'createForumTopic') return { ok: true, result: { message_thread_id: 500 + calls.length } }
    if (method.startsWith('send')) return { ok: true, result: { message_id: nextMessageId++ } }
    return { ok: true, result: true }
  }
  const telegram = createSupportTelegram({
    call,
    store,
    getSupportChatId: async () => supportChatId,
    getOwnerChatId: async () => ownerChatId
  })
  return { store, telegram, calls }
}

async function newThread(store) {
  return store.createThread(ID, { shortId: 'a3f9', country: 'BD', kind: 'problem' })
}

const content = over => ({ kind: 'problem', topicText: 'help', ownerText: '#a3f9 BD\n\nhelp', images: [], logs: '', ...over })
const methods = calls => calls.map(c => c.method)

test('the first message opens a topic named after the user and is posted in it', async () => {
  const { store, telegram, calls } = setup()
  const thread = await newThread(store)

  const out = await telegram.deliver(thread, content())

  assert.equal(out.route, 'topic')
  assert.deepEqual(methods(calls), ['createForumTopic', 'sendMessage'])
  assert.equal(calls[0].payload.name, '#a3f9 BD - Problem')
  assert.equal(calls[1].payload.message_thread_id, out.topicId)
  assert.equal((await store.getThread(ID)).topicId, out.topicId)
})

test('later messages reuse the topic', async () => {
  const { store, telegram, calls } = setup()
  const thread = await newThread(store)
  await telegram.deliver(thread, content())
  await telegram.deliver(await store.getThread(ID), content({ topicText: 'more' }))
  assert.equal(methods(calls).filter(m => m === 'createForumTopic').length, 1)
})

test('ideas and questions are tagged in the topic', async () => {
  const { store, telegram, calls } = setup()
  await telegram.deliver(await newThread(store), content({ kind: 'idea', topicText: 'dark mode' }))
  assert.equal(calls[1].payload.text, '[Idea] dark mode')
})

test('a deleted topic is recreated once and the message still lands', async () => {
  let failedOnce = false
  const { store, telegram, calls } = setup({
    respond: method => {
      if (method === 'sendMessage' && !failedOnce) {
        failedOnce = true
        return { ok: false, description: 'Bad Request: message thread not found' }
      }
    }
  })
  const thread = await newThread(store)
  await store.updateThread(ID, { topicId: 9 })

  const out = await telegram.deliver(await store.getThread(ID), content())

  assert.equal(out.route, 'topic')
  assert.deepEqual(methods(calls), ['sendMessage', 'createForumTopic', 'sendMessage'])
  assert.notEqual((await store.getThread(ID)).topicId, 9)
  assert.ok(thread)
})

test('without a support group the owner chat gets the message and replies can be mapped', async () => {
  const { store, telegram, calls } = setup({ supportChatId: null })
  const out = await telegram.deliver(await newThread(store), content())
  assert.equal(out.route, 'owner')
  assert.equal(calls[0].payload.chat_id, '42')
  assert.equal(calls[0].payload.text, '#a3f9 BD\n\nhelp')
  assert.equal(await store.lookupTelegramMessage('42', 100), ID)
})

test('a group that cannot make topics falls back to the owner chat', async () => {
  const { store, telegram } = setup({
    respond: method => (method === 'createForumTopic' ? { ok: false, description: 'not enough rights' } : undefined)
  })
  const out = await telegram.deliver(await newThread(store), content())
  assert.equal(out.route, 'owner')
})

test('nothing is delivered when Telegram refuses everywhere', async () => {
  const { store, telegram } = setup({ respond: () => ({ ok: false, description: 'network' }) })
  assert.equal(await telegram.deliver(await newThread(store), content()), null)
})

test('screenshots and the log file are sent after the text', async () => {
  const { store, telegram, calls } = setup()
  const images = [{ field: 'x', buffer: Buffer.from('a'), name: 'screenshot-1.png', mime: 'image/png' }]
  await telegram.deliver(await newThread(store), content({ images, logs: 'line one' }))
  assert.deepEqual(methods(calls), ['createForumTopic', 'sendMessage', 'sendPhoto', 'sendDocument'])
  assert.equal(calls[2].file.field, 'photo')
  assert.equal(calls[3].file.name, 'diagnostics.txt')
  assert.equal(calls[3].file.buffer.toString(), 'line one')
})

test('a screenshot Telegram will not show as a photo is sent as a file instead', async () => {
  const { store, telegram, calls } = setup({
    respond: method => (method === 'sendPhoto' ? { ok: false, description: 'PHOTO_INVALID_DIMENSIONS' } : undefined)
  })
  const images = [{ buffer: Buffer.from('tall'), name: 'tall.png', mime: 'image/png' }]
  const out = await telegram.deliver(await newThread(store), content({ images }))
  assert.equal(out.route, 'topic')
  assert.deepEqual(methods(calls), ['createForumTopic', 'sendMessage', 'sendPhoto', 'sendDocument'])
  assert.equal(calls[3].file.field, 'document')
  assert.equal(calls[3].file.name, 'tall.png')
})

test('owner chat attachments are mapped too so a reply to any of them routes', async () => {
  const { store, telegram } = setup({ supportChatId: null })
  const images = [{ buffer: Buffer.from('a'), name: 's.png', mime: 'image/png' }]
  await telegram.deliver(await newThread(store), content({ images }))
  assert.equal(await store.lookupTelegramMessage('42', 100), ID)
  assert.equal(await store.lookupTelegramMessage('42', 101), ID)
})

test('setup is only accepted when the bot can really manage topics', async () => {
  const ok = setup()
  assert.deepEqual(await ok.telegram.probeTopics('-100'), { ok: true })
  assert.deepEqual(methods(ok.calls), ['createForumTopic', 'deleteForumTopic'])

  const bad = setup({ respond: () => ({ ok: false, description: 'chat is not a forum' }) })
  assert.deepEqual(await bad.telegram.probeTopics('-100'), { ok: false, reason: 'chat is not a forum' })
})

test('the reply push carries a preview, a data type and the support channel', () => {
  const message = buildReplyMessage('fcm-token', { text: 'Try  port\n22', seq: 4 })
  assert.equal(message.token, 'fcm-token')
  assert.equal(message.notification.body, 'Try port 22')
  assert.deepEqual(message.data, { type: 'support_reply', seq: '4' })
  assert.equal(message.android.notification.channel_id, SUPPORT_CHANNEL)
  assert.equal(message.android.notification.title_loc_key, 'support_reply_title')
  for (const value of Object.values(message.data)) assert.equal(typeof value, 'string')
})

test('push reports why nothing was sent instead of throwing', async () => {
  const sent = []
  const make = over =>
    createSupportPush({ send: async m => sent.push(m), getFcmToken: async () => 'tok', enabled: () => true, ...over })

  assert.deepEqual(await make({ enabled: () => false }).notifyReply(ID, { text: 'x', seq: 1 }), { sent: false, reason: 'disabled' })
  assert.deepEqual(await make({ getFcmToken: async () => null }).notifyReply(ID, { text: 'x', seq: 1 }), { sent: false, reason: 'no_token' })
  assert.deepEqual(await make({}).notifyReply(ID, { text: 'x', seq: 1 }), { sent: true })
  assert.equal(sent.length, 1)
  const failing = make({
    send: async () => {
      throw Object.assign(new Error('x'), { code: 'messaging/registration-token-not-registered' })
    }
  })
  assert.deepEqual(await failing.notifyReply(ID, { text: 'x', seq: 1 }), {
    sent: false,
    reason: 'messaging/registration-token-not-registered'
  })
})
