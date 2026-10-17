import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryStore } from './supportMemoryStore.js'
import { createSupportService, createLimiters } from './supportService.js'
import { createOwnerBridge, inboxText } from './supportOwnerBridge.js'

const ID = '3f2b8c1e-5a47-4d6e-9b0a-1c2d3e4f5a6b'
const OWNER = 42
const GROUP = -1001

function setup({ supportChatId = GROUP, probe = { ok: true }, pushed = { sent: true } } = {}) {
  const store = createMemoryStore()
  const said = []
  const ops = []
  let configured = supportChatId
  const telegram = {
    async deliver() {
      return { route: 'topic', topicId: 7 }
    },
    async say(chatId, topicId, text) {
      said.push({ chatId, topicId, text })
    },
    async closeTopic(chatId, topicId) {
      ops.push(['close', chatId, topicId])
    },
    async deleteTopic(chatId, topicId) {
      ops.push(['delete', chatId, topicId])
    },
    async reopenTopic() {},
    async probeTopics() {
      return probe
    }
  }
  const push = { notifyReply: async () => pushed }
  const service = createSupportService({
    store,
    telegram,
    push,
    getSupportChatId: async () => configured,
    limiters: createLimiters()
  })
  const bridge = createOwnerBridge({
    store,
    telegram,
    service,
    getSupportChatId: async () => configured,
    setSupportChatId: async id => {
      configured = id
    },
    getOwnerId: async () => OWNER,
    now: () => 10 * 60_000
  })
  return { store, service, bridge, said, ops, configured: () => configured }
}

const group = (text, over = {}) => ({
  message: { text, chat: { id: GROUP, type: 'supergroup' }, from: { id: OWNER }, message_thread_id: 7, ...over }
})
const priv = (text, over = {}) => ({ message: { text, chat: { id: OWNER, type: 'private' }, from: { id: OWNER }, ...over } })

async function withThread(ctx) {
  await ctx.service.submitUserMessage({ installId: ID, text: 'help me' }, { country: 'BD' })
  await ctx.store.updateThread(ID, { topicId: 7 })
}

test('writing in a user topic replies to that user', async () => {
  const ctx = setup()
  await withThread(ctx)

  assert.equal(await ctx.bridge.handleUpdate(group('Try port 22')), true)

  const messages = await ctx.store.listMessages(ID)
  assert.deepEqual(messages.map(m => [m.from, m.text]), [['user', 'help me'], ['owner', 'Try port 22']])
  assert.equal(ctx.said.length, 0, 'a delivered push needs no extra note')
})

test('the owner is told when the user could not be notified', async () => {
  const ctx = setup({ pushed: { sent: false, reason: 'no_token' } })
  await withThread(ctx)
  await ctx.bridge.handleUpdate(group('hello'))
  assert.match(ctx.said[0].text, /no_token/)
  assert.equal(ctx.said[0].topicId, 7)
})

test('only the owner can reply, and others are silently ignored', async () => {
  const ctx = setup()
  await withThread(ctx)
  assert.equal(await ctx.bridge.handleUpdate(group('hi', { from: { id: 999 } })), true)
  assert.equal((await ctx.store.listMessages(ID)).length, 1)
  assert.equal(ctx.said.length, 0)
})

test('other groups and non-text updates are left to the existing bot', async () => {
  const ctx = setup()
  assert.equal(await ctx.bridge.handleUpdate(group('hi', { chat: { id: -5, type: 'supergroup' } })), false)
  assert.equal(await ctx.bridge.handleUpdate({ message: { chat: { id: GROUP, type: 'supergroup' }, from: { id: OWNER } } }), false)
  assert.equal(await ctx.bridge.handleUpdate({}), false)
})

test('/close closes the thread and its topic', async () => {
  const ctx = setup()
  await withThread(ctx)
  await ctx.bridge.handleUpdate(group('/close'))
  assert.equal((await ctx.store.getThread(ID)).status, 'closed')
  assert.deepEqual(ctx.ops, [['close', GROUP, 7]])
})

test('/delete erases the thread and its topic as a deletion request', async () => {
  const ctx = setup()
  await withThread(ctx)
  await ctx.bridge.handleUpdate(group('/delete'))
  assert.equal(await ctx.store.getThread(ID), null)
  assert.deepEqual(ctx.ops, [['delete', GROUP, 7]])
})

test('/block and /unblock toggle the user', async () => {
  const ctx = setup()
  await withThread(ctx)
  await ctx.bridge.handleUpdate(group('/block'))
  assert.equal((await ctx.store.getThread(ID)).blocked, true)
  await ctx.bridge.handleUpdate(group('/unblock@mybot'))
  assert.equal((await ctx.store.getThread(ID)).blocked, false)
})

test('/info lists what the app sent without the install id', async () => {
  const ctx = setup()
  await ctx.service.submitUserMessage({ installId: ID, text: 'x', context: { appVersion: '2.5.8' } }, { country: 'BD' })
  await ctx.store.updateThread(ID, { topicId: 7 })
  await ctx.bridge.handleUpdate(group('/info'))
  assert.match(ctx.said[0].text, /appVersion: 2\.5\.8/)
  assert.ok(!ctx.said[0].text.includes(ID))
})

test('a topic with no linked user, and the General topic, explain themselves', async () => {
  const ctx = setup()
  await ctx.bridge.handleUpdate(group('hi', { message_thread_id: 99 }))
  assert.match(ctx.said[0].text, /not linked/)
  await ctx.bridge.handleUpdate(group('hi', { message_thread_id: undefined }))
  assert.match(ctx.said[1].text, /inside a user topic/)
})

test('/setup connects a group only after the topic probe passes', async () => {
  const ok = setup({ supportChatId: null })
  await ok.bridge.handleUpdate(group('/setup', { chat: { id: GROUP, type: 'supergroup' }, message_thread_id: undefined }))
  assert.equal(ok.configured(), GROUP)
  assert.match(ok.said[0].text, /connected/)

  const bad = setup({ supportChatId: null, probe: { ok: false, reason: 'not a forum' } })
  await bad.bridge.handleUpdate(group('/setup', { message_thread_id: undefined }))
  assert.equal(bad.configured(), null)
  assert.match(bad.said[0].text, /not a forum/)
})

test('/setup from anyone but the owner does nothing', async () => {
  const ctx = setup({ supportChatId: null })
  await ctx.bridge.handleUpdate(group('/setup', { from: { id: 999 } }))
  assert.equal(ctx.configured(), null)
})

test('/inbox lists open threads with unread counts', async () => {
  const ctx = setup()
  await withThread(ctx)
  await ctx.bridge.handleUpdate(group('/inbox'))
  assert.match(ctx.said[0].text, /#[0-9a-f]{4} BD \| 1 unread/)
  assert.equal(inboxText([], 0), 'No open threads.')
})

test('without a group, replying to a forwarded message answers that user', async () => {
  const ctx = setup({ supportChatId: null })
  await withThread(ctx)
  await ctx.store.mapTelegramMessage(OWNER, 555, ID)

  assert.equal(await ctx.bridge.handleUpdate(priv('Use the firewall', { reply_to_message: { message_id: 555 } })), true)
  assert.equal((await ctx.store.listMessages(ID)).at(-1).text, 'Use the firewall')
})

test('private messages that are not support replies fall through to the analytics bot', async () => {
  const ctx = setup()
  assert.equal(await ctx.bridge.handleUpdate(priv('/analysis 7')), false)
  assert.equal(await ctx.bridge.handleUpdate(priv('45')), false)
  assert.equal(await ctx.bridge.handleUpdate(priv('hi', { reply_to_message: { message_id: 1 } })), false)
  assert.equal(await ctx.bridge.handleUpdate(priv('hi', { from: { id: 7 }, chat: { id: 7, type: 'private' } })), false)
})

test('/inbox also works in the private chat', async () => {
  const ctx = setup()
  await withThread(ctx)
  assert.equal(await ctx.bridge.handleUpdate(priv('/inbox')), true)
  assert.match(ctx.said[0].text, /unread/)
})
