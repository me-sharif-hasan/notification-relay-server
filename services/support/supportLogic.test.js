import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SupportError,
  contextSummary,
  createWindowLimiter,
  isInstallId,
  normalizeKind,
  ownerMessageText,
  parseCountry,
  previewOf,
  redactLog,
  redactSecrets,
  sanitizeContext,
  shortId,
  topicTitle,
  validateMessage
} from './supportLogic.js'

const ID = '3f2b8c1e-5a47-4d6e-9b0a-1c2d3e4f5a6b'
const png = Buffer.from('fake-image-bytes').toString('base64')

const rejects = (fn, status, code) =>
  assert.throws(fn, err => err instanceof SupportError && err.status === status && err.code === code)

test('install ids must be v4-style uuids', () => {
  assert.ok(isInstallId(ID))
  for (const bad of ['', 'abc', null, undefined, 42, `${ID}x`, ID.toUpperCase().replace(/-/g, '')]) {
    assert.equal(isInstallId(bad), false, String(bad))
  }
})

test('shortId is stable, short, and does not reveal the install id', () => {
  assert.equal(shortId(ID), shortId(ID))
  assert.match(shortId(ID), /^[0-9a-f]{4}$/)
  assert.ok(!ID.includes(shortId(ID)) || shortId(ID).length === 4)
  assert.notEqual(shortId(ID), shortId('3f2b8c1e-5a47-4d6e-9b0a-1c2d3e4f5a6c'))
})

test('a valid message is trimmed and normalised', () => {
  const out = validateMessage({ installId: ID, text: '  hello  ', kind: 'idea', context: { appVersion: '2.5.8' } })
  assert.equal(out.text, 'hello')
  assert.equal(out.kind, 'idea')
  assert.deepEqual(out.context, { appVersion: '2.5.8' })
  assert.deepEqual(out.images, [])
})

test('unknown kinds fall back to problem', () => {
  assert.equal(normalizeKind('weird'), 'problem')
  assert.equal(normalizeKind('question'), 'question')
})

test('invalid messages are rejected with a precise code', () => {
  rejects(() => validateMessage({ installId: 'nope', text: 'x' }), 400, 'invalid_install_id')
  rejects(() => validateMessage({ installId: ID, text: '   ' }), 400, 'empty_message')
  rejects(() => validateMessage({ installId: ID, text: 'x'.repeat(2001) }), 400, 'text_too_long')
  rejects(() => validateMessage(null), 400, 'invalid_install_id')
})

test('images are checked for count, type, encoding and size', () => {
  const ok = { mime: 'image/png', data: png }
  assert.equal(validateMessage({ installId: ID, text: '', images: [ok] }).images[0].name, 'screenshot-1.png')
  rejects(() => validateMessage({ installId: ID, text: 'x', images: [ok, ok, ok, ok] }), 400, 'too_many_images')
  rejects(() => validateMessage({ installId: ID, text: 'x', images: [{ mime: 'image/gif', data: png }] }), 400, 'invalid_image')
  rejects(() => validateMessage({ installId: ID, text: 'x', images: [{ mime: 'image/png', data: 'not base64 !!' }] }), 400, 'invalid_image')
  const huge = 'A'.repeat(Math.ceil((4 * 1024 * 1024 * 4) / 3) + 8)
  rejects(() => validateMessage({ installId: ID, text: 'x', images: [{ mime: 'image/png', data: huge }] }), 413, 'image_too_large')
})

test('secrets in text are removed before anything is stored or forwarded', () => {
  const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\ndef\n-----END OPENSSH PRIVATE KEY-----'
  assert.equal(redactSecrets(`my key ${key} ok`), 'my key [private key removed] ok')
  assert.equal(redactSecrets('password: hunter2'), 'password: [removed]')
  assert.equal(redactSecrets('PASSWD=abc123 and token = xyz'), 'PASSWD=[removed] and token = [removed]')
  assert.equal(redactSecrets('Authorization: Bearer abcdefghijklmnop1234'), 'Authorization: Bearer [removed]')
  assert.equal(redactSecrets('sshpass -p secret ssh host'), 'sshpass -p [removed] ssh host')
  assert.equal(redactSecrets('connection refused on port 22'), 'connection refused on port 22')
})

test('an unterminated private key block is still removed', () => {
  assert.equal(redactSecrets('x -----BEGIN RSA PRIVATE KEY-----\nMIIE'), 'x [private key removed]')
})

test('logs also lose addresses and mail addresses', () => {
  assert.equal(redactLog('connect 203.0.113.10 as bob@example.com'), 'connect [ip] as [email]')
  assert.equal(redactLog('version 2.5.8 build 141'), 'version 2.5.8 build 141')
})

test('only known context fields survive, trimmed and single-line', () => {
  const out = sanitizeContext({
    appVersion: '2.5.8',
    device: 'Pixel 8\nPro',
    evil: 'x',
    lastError: 'refused password=abc',
    sdk: 34,
    nested: { a: 1 },
    empty: ''
  })
  assert.deepEqual(out, { appVersion: '2.5.8', device: 'Pixel 8 Pro', lastError: 'refused password=[removed]', sdk: '34' })
  assert.deepEqual(sanitizeContext(null), {})
})

test('topic title shows the short id, country and kind', () => {
  assert.equal(topicTitle({ shortId: 'a3f9', country: 'BD', kind: 'idea' }), '#a3f9 BD - Idea')
  assert.equal(topicTitle({ shortId: 'a3f9', country: 'unknown', kind: 'problem' }), '#a3f9 ?? - Problem')
})

test('the owner sees a readable summary and never the install id', () => {
  const context = { appVersion: '2.5.8', appBuild: '141', androidVersion: '14', lastError: 'connection refused' }
  const text = ownerMessageText({ shortId: 'a3f9', country: 'BD', kind: 'problem', text: 'help', context })
  assert.match(text, /App 2\.5\.8 \(141\) \| Android 14/)
  assert.match(text, /Last error: connection refused/)
  assert.ok(text.endsWith('help'))
  assert.ok(!text.includes(ID))
  assert.equal(contextSummary({}), '')
})

test('previews are single-line and bounded', () => {
  assert.equal(previewOf('a\n\n  b'), 'a b')
  assert.equal(previewOf('x'.repeat(200)).length, 90)
})

test('country comes only from a clean two-letter header', () => {
  assert.equal(parseCountry('bd'), 'BD')
  for (const bad of ['', 'XX', 'T1', 'BDX', undefined, 5]) assert.equal(parseCountry(bad), 'unknown')
})

test('the window limiter allows max hits per window and then resets', () => {
  let t = 0
  const limiter = createWindowLimiter({ windowMs: 1000, max: 2, now: () => t })
  assert.deepEqual([limiter.take('a'), limiter.take('a'), limiter.take('a')], [true, true, false])
  assert.equal(limiter.take('b'), true)
  t = 1000
  assert.equal(limiter.take('a'), true)
  limiter.sweep()
})
