import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_MUTE_MINUTES, muteStatus, parseMuteRequest } from './muteState.js'

const now = new Date('2026-01-01T12:00:00.000Z')

test('parseMuteRequest turns minutes into an expiry', () => {
  const result = parseMuteRequest({ minutes: 90 }, now)
  assert.equal(result.mutedIndefinitely, false)
  assert.equal(result.mutedUntil.toISOString(), '2026-01-01T13:30:00.000Z')
})

test('parseMuteRequest accepts an indefinite mute', () => {
  assert.deepEqual(parseMuteRequest({ indefinite: true }, now), { mutedUntil: null, mutedIndefinitely: true })
})

test('parseMuteRequest rejects missing, fractional, zero and oversized minutes', () => {
  for (const body of [{}, null, { minutes: 0 }, { minutes: 1.5 }, { minutes: '30' }, { minutes: MAX_MUTE_MINUTES + 1 }]) {
    assert.ok(parseMuteRequest(body, now).error, JSON.stringify(body))
  }
})

test('parseMuteRequest accepts the largest allowed duration', () => {
  assert.ok(!parseMuteRequest({ minutes: MAX_MUTE_MINUTES }, now).error)
})

test('muteStatus is not muted for a fresh or empty document', () => {
  assert.deepEqual(muteStatus({}, now), { muted: false, indefinite: false, until: null })
  assert.deepEqual(muteStatus(undefined, now), { muted: false, indefinite: false, until: null })
})

test('muteStatus is muted until the expiry and clears itself afterwards', () => {
  const until = new Date('2026-01-01T12:30:00.000Z')
  assert.deepEqual(muteStatus({ mutedUntil: until }, now), {
    muted: true,
    indefinite: false,
    until: '2026-01-01T12:30:00.000Z'
  })
  assert.equal(muteStatus({ mutedUntil: until }, new Date('2026-01-01T12:30:00.000Z')).muted, false)
  assert.equal(muteStatus({ mutedUntil: until }, new Date('2026-01-01T13:00:00.000Z')).muted, false)
})

test('muteStatus reads Firestore timestamps', () => {
  const stamp = { toDate: () => new Date('2026-01-01T12:10:00.000Z') }
  assert.equal(muteStatus({ mutedUntil: stamp }, now).muted, true)
})

test('muteStatus stays muted while indefinite', () => {
  assert.deepEqual(muteStatus({ mutedIndefinitely: true }, now), { muted: true, indefinite: true, until: null })
})
