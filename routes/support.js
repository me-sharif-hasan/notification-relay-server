import { requireJwt } from '../middleware/requireJwt.js'
import { MAX_REQUEST_BYTES, SupportError, parseCountry } from '../services/support/supportLogic.js'

const BODY_LIMIT = MAX_REQUEST_BYTES

function fail(request, reply, err) {
  if (err instanceof SupportError) return reply.code(err.status).send({ success: false, error: err.code })
  request.log.error({ err: err?.message, action: 'support_failed' })
  return reply.code(500).send({ success: false, error: 'server_error' })
}

// `getService` and `auth` are injected so the routes can be tested without
// Firebase; `supportRoutes` below wires the real ones.
export async function registerSupportRoutes(app, { getService, auth = requireJwt }) {
  // 'warn' keeps the per-request access log, which holds the client IP, out of the logs.
  const options = { preHandler: auth, logLevel: 'warn' }

  app.post('/support/messages', { ...options, bodyLimit: BODY_LIMIT }, async (request, reply) => {
    try {
      const service = await getService()
      const country = parseCountry(request.headers['cf-ipcountry'])
      return { success: true, ...(await service.submitUserMessage(request.body, { country })) }
    } catch (err) {
      return fail(request, reply, err)
    }
  })

  app.get('/support/messages', options, async (request, reply) => {
    try {
      const service = await getService()
      const { installId, after, markRead } = request.query ?? {}
      const result = await service.listForUser(installId, {
        after: Math.max(0, Number(after) || 0),
        markRead: markRead === '1' || markRead === 'true'
      })
      return { success: true, ...result }
    } catch (err) {
      return fail(request, reply, err)
    }
  })

  app.get('/support/unread', options, async (request, reply) => {
    try {
      const service = await getService()
      return { success: true, ...(await service.unreadFor(request.query?.installId)) }
    } catch (err) {
      return fail(request, reply, err)
    }
  })
}

export async function supportRoutes(app) {
  const { getSupport } = await import('../services/support/supportWiring.js')
  await registerSupportRoutes(app, { getService: async () => getSupport().service })
}
