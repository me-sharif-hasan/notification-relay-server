import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'crypto'
import { buildAlertData } from './alertPayload.js'

const now = new Date('2026-01-01T12:00:00.000Z')

test('buildAlertData stringifies every field and forwards the server name', () => {
  const data = buildAlertData(
    { metric: 'cpu', level: 'crit', value: 97, host: 'vps-1', server_name: 'Prod (ubuntu 24)', timestamp: '2026-01-01T11:59:00Z' },
    'tok',
    now
  )
  assert.deepEqual(Object.keys(data).sort(), ['host', 'level', 'metric', 'server_name', 'timestamp', 'token_id', 'value'])
  for (const value of Object.values(data)) assert.equal(typeof value, 'string')
  assert.equal(data.value, '97')
  assert.equal(data.server_name, 'Prod (ubuntu 24)')
  assert.equal(data.timestamp, '2026-01-01T11:59:00Z')
})

test('buildAlertData tolerates agents that send no server name or timestamp', () => {
  const data = buildAlertData({ metric: 'mem', level: 'warn', value: 81, host: 'vps-1' }, 'tok', now)
  assert.equal(data.server_name, '')
  assert.equal(data.timestamp, '2026-01-01T12:00:00.000Z')
})

test('token_id is a hash and never the token itself', () => {
  const data = buildAlertData({ metric: 'disk', level: 'warn', value: 90, host: 'h' }, 'secret-token', now)
  assert.equal(data.token_id, createHash('sha256').update('secret-token').digest('hex'))
  assert.ok(!Object.values(data).includes('secret-token'))
})
