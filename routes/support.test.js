import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { registerSupportRoutes } from './support.js'
import { requireJwt } from '../middleware/requireJwt.js'
import { signJwt } from '../auth/jwt.js'
import { createMemoryStore } from '../services/support/supportMemoryStore.js'
import { createSupportService, createLimiters } from '../services/support/supportService.js'

process.env.JWT_SECRET = 'test-secret'

const ID = '3f2b8c1e-5a47-4d6e-9b0a-1c2d3e4f5a6b'
const OTHER = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d'
const jwt = () => `Bearer ${signJwt({ sub: 'device-1', plan: 'free' }, 'test-secret')}`

async function build({ deliver = async () => ({ route: 'topic', topicId: 7 }) } = {}) {
  const store = createMemoryStore()
  const delivered = []
  const telegram = {
    deliver: async (thread, content) => {
      delivered.push({ thread, content })
      return deliver()
    },
    reopenTopic: async () => {}
  }
  const push = { notifyReply: async () => ({ sent: true }) }
  const service = createSupportService({ store, telegram, push, limiters: createLimiters() })
  const app = Fastify()
  await registerSupportRoutes(app, { getService: async () => service, auth: requireJwt })
  await app.ready()
  return { app, store, service, delivered }
}

const post = (app, body, headers = {}) =>
  app.inject({ method: 'POST', url: '/support/messages', payload: body, headers: { authorization: jwt(), ...headers } })

test('every route needs a valid token', async () => {
  const { app } = await build()
  for (const [method, url] of [['POST', '/support/messages'], ['GET', `/support/messages?installId=${ID}`], ['GET', `/support/unread?installId=${ID}`]]) {
    assert.equal((await app.inject({ method, url })).statusCode, 401, url)
    assert.equal((await app.inject({ method, url, headers: { authorization: 'Bearer nope' } })).statusCode, 401, url)
  }
})

test('a message is stored, forwarded, and the country comes from the edge header', async () => {
  const { app, store, delivered } = await build()
  const res = await post(app, { installId: ID, text: 'help', kind: 'problem', context: { appVersion: '2.5.8' } }, { 'cf-ipcountry': 'bd' })

  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.success, true)
  assert.equal(body.delivered, true)
  assert.equal(body.message.id, 1)
  assert.equal((await store.getThread(ID)).country, 'BD')
  assert.equal(delivered.length, 1)
})

test('the client address is never part of what is stored or forwarded', async () => {
  const { app, store, delivered } = await build()
  await post(app, { installId: ID, text: 'help' }, { 'x-forwarded-for': '203.0.113.9', 'cf-connecting-ip': '203.0.113.9' })
  assert.ok(!JSON.stringify(await store.getThread(ID)).includes('203.0.113.9'))
  assert.ok(!JSON.stringify(delivered).includes('203.0.113.9'))
})

test('bad input gets a 4xx with a code and stores nothing', async () => {
  const { app, store } = await build()
  const cases = [
    [{ installId: 'x', text: 'a' }, 400, 'invalid_install_id'],
    [{ installId: ID, text: '' }, 400, 'empty_message'],
    [{ installId: ID, text: 'a', images: [{ mime: 'text/html', data: 'AAAA' }] }, 400, 'invalid_image']
  ]
  for (const [body, status, code] of cases) {
    const res = await post(app, body)
    assert.equal(res.statusCode, status)
    assert.equal(res.json().error, code)
  }
  assert.equal(await store.getThread(ID), null)
})

test('a Telegram outage still accepts the message and flags it for the developer', async () => {
  const { app, store, service } = await build({ deliver: async () => null })
  const body = (await post(app, { installId: ID, text: 'help' })).json()
  await service.settled()
  assert.equal(body.success, true)
  assert.equal((await store.getThread(ID)).forwardError, true)
  assert.equal((await store.listMessages(ID)).length, 1)
})

test('too many messages in a minute returns 429', async () => {
  const { app } = await build()
  for (let i = 0; i < 6; i++) assert.equal((await post(app, { installId: ID, text: `m${i}` })).statusCode, 200)
  assert.equal((await post(app, { installId: ID, text: 'one more' })).statusCode, 429)
})

test('the user reads replies after a point and the unread badge clears on read', async () => {
  const { app, service } = await build()
  await post(app, { installId: ID, text: 'help' })
  await service.ownerReply(ID, 'try port 22')

  const unread = await app.inject({ method: 'GET', url: `/support/unread?installId=${ID}`, headers: { authorization: jwt() } })
  assert.deepEqual(unread.json(), { success: true, unread: 1 })

  const list = await app.inject({ method: 'GET', url: `/support/messages?installId=${ID}&after=1&markRead=1`, headers: { authorization: jwt() } })
  assert.deepEqual(list.json().messages.map(m => m.text), ['try port 22'])
  assert.equal(list.json().unread, 0)

  const again = await app.inject({ method: 'GET', url: `/support/unread?installId=${ID}`, headers: { authorization: jwt() } })
  assert.equal(again.json().unread, 0)
})

test('one install cannot read another install\'s thread', async () => {
  const { app } = await build()
  await post(app, { installId: ID, text: 'private' })
  const res = await app.inject({ method: 'GET', url: `/support/messages?installId=${OTHER}`, headers: { authorization: jwt() } })
  assert.deepEqual(res.json().messages, [])
})

test('a bad install id on a read is a 400', async () => {
  const { app } = await build()
  const res = await app.inject({ method: 'GET', url: '/support/unread?installId=nope', headers: { authorization: jwt() } })
  assert.equal(res.statusCode, 400)
})

test('an unexpected failure is a plain 500 that leaks nothing', async () => {
  const { app, service } = await build()
  service.submitUserMessage = async () => {
    throw new Error('firestore exploded: secret detail')
  }
  const res = await post(app, { installId: ID, text: 'help' })
  assert.equal(res.statusCode, 500)
  assert.deepEqual(res.json(), { success: false, error: 'server_error' })
})

test('screenshots up to the size cap are accepted', async () => {
  const { app, delivered } = await build()
  const data = Buffer.alloc(300 * 1024, 1).toString('base64')
  const res = await post(app, { installId: ID, text: '', images: [{ mime: 'image/jpeg', data }], logs: 'App log line' })
  assert.equal(res.statusCode, 200)
  assert.equal(delivered[0].content.images.length, 1)
  assert.equal(delivered[0].content.logs, 'App log line')
  assert.equal(res.json().message.attachments, 2)
})
