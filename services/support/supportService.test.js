import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryStore } from './supportMemoryStore.js'
import { createSupportService, createLimiters } from './supportService.js'
import { SupportError } from './supportLogic.js'

const ID = '3f2b8c1e-5a47-4d6e-9b0a-1c2d3e4f5a6b'
const OTHER = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d'

function setup({ deliver, supportChatId = '-100', clock = { t: 1000 } } = {}) {
  const now = () => clock.t
  const store = createMemoryStore({ now })
  const calls = { deliver: [], reopen: [], push: [], deletedTopics: [], deletedTokens: [] }
  const telegram = {
    async deliver(thread, content) {
      calls.deliver.push({ thread, content })
      return deliver ? deliver() : { route: 'topic', topicId: 7 }
    },
    async reopenTopic(chatId, topicId) {
      calls.reopen.push([chatId, topicId])
    },
    async deleteTopic(chatId, topicId) {
      calls.deletedTopics.push([chatId, topicId])
    }
  }
  const push = {
    async notifyReply(installId, message) {
      calls.push.push({ installId, message })
      return { sent: true }
    }
  }
  const service = createSupportService({
    store,
    telegram,
    push,
    getSupportChatId: async () => supportChatId,
    deleteDeviceToken: async id => {
      calls.deletedTokens.push(id)
    },
    limiters: createLimiters(now)
  })
  return { store, service, calls, clock }
}

const send = (service, over = {}, opts = { country: 'BD' }) =>
  service.submitUserMessage({ installId: ID, text: 'help me', kind: 'problem', ...over }, opts)

test('a first message creates the thread and reaches the developer', async () => {
  const { store, service, calls } = setup()
  const out = await send(service, { context: { appVersion: '2.5.8', lastError: 'refused' } })
  await service.settled()

  assert.equal(out.delivered, true)
  assert.equal((await store.getThread(ID)).forwardError, false)
  assert.deepEqual(Object.keys(out.message).sort(), ['attachments', 'createdAt', 'from', 'id', 'kind', 'text'])
  assert.equal(out.message.id, 1)
  const thread = await store.getThread(ID)
  assert.equal(thread.country, 'BD')
  assert.equal(thread.unreadForOwner, 1)
  assert.equal(calls.deliver.length, 1)
  assert.match(calls.deliver[0].content.topicText, /App 2\.5\.8/)
  assert.match(calls.deliver[0].content.topicText, /help me$/)
  assert.ok(!JSON.stringify(calls.deliver[0].content).includes(ID))
})

test('a Telegram failure never loses the message and is recorded for the developer', async () => {
  const { store, service } = setup({ deliver: () => null })
  const out = await send(service)
  await service.settled()
  assert.equal(out.delivered, true, 'the user is told it was received')
  assert.equal((await store.getThread(ID)).forwardError, true)
  assert.equal((await store.listMessages(ID)).length, 1)
})

test('a throwing Telegram adapter is treated like a failure', async () => {
  const { store, service } = setup({
    deliver: () => {
      throw new Error('boom')
    }
  })
  await send(service)
  await service.settled()
  assert.equal((await store.getThread(ID)).forwardError, true)
})

test('the user is answered before a slow Telegram finishes', async () => {
  let release
  const gate = new Promise(resolve => (release = resolve))
  const { service } = setup({ deliver: () => gate.then(() => ({ route: 'topic', topicId: 7 })) })

  const out = await send(service)
  assert.equal(out.delivered, true)

  let settled = false
  service.settled().then(() => (settled = true))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false, 'the forward is still running in the background')
  release()
  await service.settled()
})

test('a later message reuses the thread and merges the context', async () => {
  const { store, service } = setup()
  await send(service, { context: { appVersion: '2.5.8' } })
  await send(service, { text: 'again', context: { device: 'Pixel' } }, { country: 'unknown' })
  const thread = await store.getThread(ID)
  assert.equal(thread.seq, 2)
  assert.deepEqual(thread.context, { appVersion: '2.5.8', device: 'Pixel' })
  assert.equal(thread.country, 'BD', 'an unknown country does not erase a known one')
})

test('invalid input is rejected before anything is stored', async () => {
  const { store, service, calls } = setup()
  await assert.rejects(send(service, { text: '' }), err => err instanceof SupportError && err.code === 'empty_message')
  assert.equal(await store.getThread(ID), null)
  assert.equal(calls.deliver.length, 0)
})

test('a blocked user is refused', async () => {
  const { store, service } = setup()
  await send(service)
  await store.updateThread(ID, { blocked: true })
  await assert.rejects(send(service), err => err.status === 403 && err.code === 'blocked')
})

test('writing is rate limited per install and recovers after the window', async () => {
  const { service, clock } = setup()
  for (let i = 0; i < 6; i++) await send(service)
  await assert.rejects(send(service), err => err.status === 429)
  clock.t += 61_000
  await send(service)
})

test('an install may send 1000 messages a day and not one more', async () => {
  const { service, clock } = setup()
  for (let i = 0; i < 1000; i++) {
    if (i % 6 === 0) clock.t += 61_000
    await send(service, { text: `m${i}` })
  }
  clock.t += 61_000
  await assert.rejects(send(service), err => err.status === 429)
  clock.t += 86_400_000
  assert.equal((await send(service)).delivered, true, 'a new day starts clean')
})

test('limits are checked before any screenshot is decoded', async () => {
  const { service, calls } = setup()
  for (let i = 0; i < 6; i++) await send(service)
  const data = Buffer.alloc(1024, 1).toString('base64')
  await assert.rejects(
    send(service, { images: [{ mime: 'image/png', data }] }),
    err => err.status === 429
  )
  assert.equal(calls.deliver.length, 6)
})

test('screenshots have their own daily allowance', async () => {
  const { service, clock } = setup()
  const images = [{ mime: 'image/png', data: Buffer.alloc(64, 1).toString('base64') }]
  for (let i = 0; i < 60; i++) {
    if (i % 6 === 0) clock.t += 61_000
    await send(service, { text: '', images })
  }
  clock.t += 61_000
  await assert.rejects(send(service, { text: '', images }), err => err.status === 429)
  assert.equal((await send(service, { text: 'text only still works' })).delivered, true)
})

test('only a capped number of messages per hour are copied to Telegram, but all are stored', async () => {
  const { store, service, calls, clock } = setup()
  for (let i = 0; i < 70; i++) {
    if (i % 6 === 0) clock.t += 61_000
    await send(service, { text: `m${i}` })
  }
  await service.settled()
  assert.equal(calls.deliver.length, 60)
  assert.equal((await store.listMessages(ID, { limit: 500 })).length, 70)
  assert.equal((await store.getThread(ID)).forwardError, true, 'the developer sees it in /inbox')
})

test('one noisy install does not use up another install\'s allowance', async () => {
  const { service } = setup()
  for (let i = 0; i < 6; i++) await send(service)
  await assert.rejects(send(service), err => err.status === 429)
  const out = await service.submitUserMessage({ installId: OTHER, text: 'hi' }, { country: 'DE' })
  assert.equal(out.delivered, true)
})

test('a message to a closed thread reopens its topic', async () => {
  const { store, service, calls } = setup()
  await send(service)
  await store.updateThread(ID, { status: 'closed', topicId: 7 })
  await send(service, { text: 'back again' })
  assert.deepEqual(calls.reopen, [['-100', 7]])
  assert.equal((await store.getThread(ID)).status, 'open')
})

test('an owner reply is stored, counted as unread and pushed', async () => {
  const { store, service, calls } = setup()
  await send(service)
  const out = await service.ownerReply(ID, '  Try port 22  ')
  assert.equal(out.message.from, 'owner')
  assert.equal(out.message.text, 'Try port 22')
  assert.equal(out.pushed.sent, true)
  assert.equal(calls.push[0].message.seq, 2)
  assert.equal((await store.getThread(ID)).unreadForUser, 1)
})

test('an owner reply needs an existing thread and some text', async () => {
  const { service } = setup()
  await assert.rejects(service.ownerReply(ID, 'x'), err => err.status === 404)
  await send(service)
  await assert.rejects(service.ownerReply(ID, '   '), err => err.code === 'empty_message')
})

test('the user lists new messages after a point and clears unread by reading', async () => {
  const { service } = setup()
  await send(service)
  await service.ownerReply(ID, 'one')
  await service.ownerReply(ID, 'two')

  assert.deepEqual(await service.unreadFor(ID), { unread: 2 })
  const peek = await service.listForUser(ID, { after: 1 })
  assert.deepEqual(peek.messages.map(m => m.text), ['one', 'two'])
  assert.equal(peek.unread, 2, 'listing without markRead keeps the badge')

  const read = await service.listForUser(ID, { after: 0, markRead: true })
  assert.equal(read.messages.length, 3)
  assert.equal(read.unread, 0)
  assert.deepEqual(await service.unreadFor(ID), { unread: 0 })
})

test('an unknown install has an empty thread, and a bad id is refused', async () => {
  const { service } = setup()
  assert.deepEqual(await service.listForUser(ID), { messages: [], unread: 0 })
  assert.deepEqual(await service.unreadFor(OTHER), { unread: 0 })
  await assert.rejects(service.listForUser('nope'), err => err.code === 'invalid_install_id')
})

test('deleting a conversation removes the messages, the topic and the push token', async () => {
  const { store, service, calls } = setup()
  await send(service)
  await store.updateThread(ID, { topicId: 7 })
  await store.mapTelegramMessage('42', 5, ID)

  assert.equal(await service.deleteConversation(ID), true)

  assert.equal(await store.getThread(ID), null)
  assert.deepEqual(await store.listMessages(ID), [])
  assert.equal(await store.lookupTelegramMessage('42', 5), null)
  assert.deepEqual(calls.deletedTopics, [['-100', 7]])
  assert.deepEqual(calls.deletedTokens, [ID])
  assert.deepEqual(await service.listForUser(ID), { messages: [], unread: 0 })
})

test('deleting a conversation that does not exist is a no-op', async () => {
  const { service, calls } = setup()
  assert.equal(await service.deleteConversation(ID), false)
  assert.deepEqual(calls.deletedTokens, [])
})

test('a topic Telegram cannot delete does not stop the data from being erased', async () => {
  const { store, service } = setup()
  await send(service)
  await store.updateThread(ID, { topicId: 7 })
  const failing = createSupportService({
    store,
    telegram: { deleteTopic: async () => { throw new Error('gone') } },
    push: { notifyReply: async () => ({ sent: true }) },
    getSupportChatId: async () => '-100'
  })
  assert.equal(await failing.deleteConversation(ID), true)
  assert.equal(await store.getThread(ID), null)
})

test('a thread is private to its install', async () => {
  const { service } = setup()
  await send(service, { text: 'secret detail' })
  assert.deepEqual((await service.listForUser(OTHER)).messages, [])
})
