import { createHash } from 'crypto'
import { addToBlocklist } from '../services/blocklist.js'

const SUBSCRIPTION_REVOKED = 13

export async function playNotificationRoutes(app) {
  // POST /api/play/notifications — Google Play RTDN (Real-time Developer Notifications) webhook
  // Google sends a Pub/Sub message; we unwrap it and act on subscription lifecycle events.
  app.post('/api/play/notifications', async (request, reply) => {
    const message = request.body?.message
    if (!message?.data) {
      return reply.code(400).send({ error: 'missing message.data' })
    }

    let notification
    try {
      notification = JSON.parse(Buffer.from(message.data, 'base64').toString('utf8'))
    } catch {
      return reply.code(400).send({ error: 'invalid base64 payload' })
    }

    const sub = notification?.subscriptionNotification
    if (!sub) {
      // Not a subscription event (could be test notification or other type) — ack and ignore
      return { ok: true }
    }

    const { notificationType, purchaseToken } = sub

    app.log.info({ notificationType, action: 'play_notification' })

    if (notificationType === SUBSCRIPTION_REVOKED && purchaseToken) {
      const ptHash = createHash('sha256').update(purchaseToken).digest('hex')
      await addToBlocklist(ptHash)
      app.log.info({ ptHash, action: 'subscription_revoked_blocklisted' })
    }

    // Always return 200 to ack the Pub/Sub message
    return { ok: true }
  })
}
