import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { dataDeletionRoutes } from './dataDeletion.js'

async function build() {
  const app = Fastify()
  await app.register(dataDeletionRoutes)
  await app.ready()
  return app
}

test('the deletion page is public and served as HTML', async () => {
  const app = await build()
  const res = await app.inject({ method: 'GET', url: '/delete-data' })
  assert.equal(res.statusCode, 200)
  assert.match(res.headers['content-type'], /^text\/html/)
  assert.match(res.body, /<title>ServerKit Data Deletion<\/title>/)
})

test('it tells people how to ask and who to ask', async () => {
  const { body } = await (await build()).inject({ method: 'GET', url: '/delete-data' })
  assert.match(body, /mailto:shanto@iishanto\.com\?subject=ServerKit%20data%20deletion/)
  for (const topic of ['Help &amp; feedback conversations', 'AI Agent free-trial record', 'Monitor Agent push token', 'uninstall the app']) {
    assert.ok(body.includes(topic), topic)
  }
  assert.match(body, /within 30 days/)
})

test('every email address is shielded from Cloudflare address rewriting', async () => {
  const { body } = await (await build()).inject({ method: 'GET', url: '/delete-data' })
  const outside = body.replace(/<!--email_off-->[\s\S]*?<!--\/email_off-->/g, '')
  assert.ok(body.includes('shanto@iishanto.com'))
  assert.ok(!outside.includes('shanto@iishanto.com'), 'an address outside the markers would be replaced by [email protected]')
  assert.equal((body.match(/<!--email_off-->/g) ?? []).length, (body.match(/<!--\/email_off-->/g) ?? []).length)
})

test('it links back to the privacy policy with an absolute address', async () => {
  const { body } = await (await build()).inject({ method: 'GET', url: '/delete-data' })
  assert.ok(body.includes('href="https://iishanto.com/app/serverkit/privacy-policy.html"'))
  assert.ok(!/href="(?!https:|mailto:)/.test(body), 'no relative links that would break off the website')
})

test('it is served with locked-down headers and no scripts', async () => {
  const res = await (await build()).inject({ method: 'GET', url: '/delete-data' })
  assert.equal(res.headers['x-content-type-options'], 'nosniff')
  assert.match(res.headers['content-security-policy'], /default-src 'none'/)
  assert.ok(!/<script/i.test(res.body))
})

test('other methods are not accepted', async () => {
  const app = await build()
  assert.equal((await app.inject({ method: 'POST', url: '/delete-data', payload: {} })).statusCode, 404)
})

test('HTML tags in the page are balanced', async () => {
  const { body } = await (await build()).inject({ method: 'GET', url: '/delete-data' })
  for (const tag of ['ul', 'li', 'h2', 'p', 'div']) {
    const open = (body.match(new RegExp(`<${tag}[ >]`, 'g')) ?? []).length
    const close = (body.match(new RegExp(`</${tag}>`, 'g')) ?? []).length
    assert.equal(open, close, tag)
  }
})
