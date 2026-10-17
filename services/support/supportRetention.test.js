import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryStore } from './supportMemoryStore.js'
import { createRetention } from './supportRetention.js'

const DAY = 86_400_000
const NOW = 1_800_000_000_000

async function setup(days = 365) {
  const store = createMemoryStore({ now: () => NOW })
  const deleted = []
  const retention = createRetention({
    store,
    days,
    now: () => NOW,
    deleteConversation: async id => {
      deleted.push(id)
      await store.deleteThread(id)
    }
  })
  return { store, retention, deleted }
}

test('conversations idle for longer than the retention period are erased, newer ones are kept', async () => {
  const { store, retention, deleted } = await setup()
  await store.createThread('old', { lastMessageAt: NOW - 366 * DAY })
  await store.createThread('edge', { lastMessageAt: NOW - 364 * DAY })
  await store.createThread('new', { lastMessageAt: NOW - DAY })

  assert.equal(await retention.sweep(), 1)

  assert.deepEqual(deleted, ['old'])
  assert.ok(await store.getThread('edge'))
  assert.ok(await store.getThread('new'))
})

test('nothing to erase is a quiet no-op', async () => {
  const { retention, deleted } = await setup()
  assert.equal(await retention.sweep(), 0)
  assert.deepEqual(deleted, [])
})

test('the period is configurable', async () => {
  const { store, retention, deleted } = await setup(30)
  await store.createThread('a', { lastMessageAt: NOW - 31 * DAY })
  await retention.sweep()
  assert.deepEqual(deleted, ['a'])
})
