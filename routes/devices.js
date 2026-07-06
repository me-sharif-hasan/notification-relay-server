import { requireJwt } from '../middleware/requireJwt.js'
import { upsertDeviceToken } from '../services/deviceTokens.js'

export async function deviceRoutes(app) {
  // POST /devices/token — register/refresh this install's push token.
  // Called on every app launch. Single source of truth for FCM tokens,
  // read by both /alert (monitor-agent pushes) and admin-triggered notification sends.
  app.post('/devices/token', { preHandler: requireJwt }, async (request, reply) => {
    const { installId, fcmToken, packageName } = request.body ?? {}
    if (!installId || !fcmToken) {
      return reply.code(400).send({ success: false, error: 'installId and fcmToken are required' })
    }

    const { sub, plan } = request.jwtPayload
    await upsertDeviceToken(installId, { fcmToken, sub, plan, packageName })

    app.log.info({ installId, sub, action: 'device_token_registered' })
    return { success: true }
  })
}
