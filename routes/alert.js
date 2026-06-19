import { admin, db } from '../firebase.js'
import { getSettings } from '../services/settings.js'
import { isRateLimited } from '../services/rateLimitMemory.js'
import { getEnv } from '../config.js'

const TOKENS = 'integrationTokens'

function formatNotification(metric, level, value, host) {
  const icon = level === 'crit' ? '🔴' : '⚠️'
  const label = { cpu: 'CPU', mem: 'Memory', disk: 'Disk' }[metric] ?? metric
  const severity = level === 'crit' ? 'Critical' : 'Warning'
  return {
    title: `${icon} ${label} ${severity} — ${host}`,
    body: `${label} at ${value}%`
  }
}

export async function alertRoutes(app) {
  // POST /alert — receive metric alert from VPS agent
  app.post('/alert', async (request, reply) => {
    const auth = request.headers.authorization
    if (!auth?.startsWith('Bearer ') || auth.length <= 7) {
      return reply.code(401).send({ error: 'Missing token' })
    }

    const token = auth.slice(7)

    if (isRateLimited(token)) {
      return reply.code(429).send({ error: 'Rate limited' })
    }

    const docRef = db.collection(TOKENS).doc(token)
    const doc = await docRef.get()

    if (!doc.exists || doc.data().revokedAt !== null) {
      return reply.code(401).send({ error: 'Invalid or revoked token' })
    }

    const { fcmToken, packageName } = doc.data()
    const { metric, level, value, host, timestamp } = request.body ?? {}

    await docRef.update({
      lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
      hitCount: admin.firestore.FieldValue.increment(1)
    })

    const settings = await getSettings()
    if (settings.skipDebugPackages && packageName?.endsWith('.debug')) {
      app.log.info({ tokenHash: token, packageName, action: 'skipped_debug' })
      return { success: true, skipped: true }
    }

    if (getEnv('SEND_FCM') === 'true') {
      const notification = formatNotification(metric, level, value, host)
      await admin.messaging().send({
        token: fcmToken,
        notification: { title: notification.title, body: notification.body },
        data: { metric, level, value: String(value), host, timestamp: timestamp ?? new Date().toISOString() },
        android: {
          priority: 'high',
          notification: { channel_id: 'monitor_alerts' }
        }
      })
    }

    app.log.info({ tokenHash: token, metric, level, value, host, timestamp })
    return { success: true }
  })
}
