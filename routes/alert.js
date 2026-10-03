import { admin, db } from '../firebase.js'
import { getSettings } from '../services/settings.js'
import { isRateLimited } from '../services/rateLimitMemory.js'
import { getEnv } from '../config.js'
import { muteStatus } from '../services/muteState.js'
import { buildAlertData } from '../services/alertPayload.js'

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
    const { metric, level, value, host, timestamp, server_name } = request.body ?? {}

    await docRef.update({
      lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
      hitCount: admin.firestore.FieldValue.increment(1)
    })

    if (muteStatus(doc.data()).muted) {
      await docRef.update({
        mutedHitCount: admin.firestore.FieldValue.increment(1),
        lastMutedAt: admin.firestore.FieldValue.serverTimestamp()
      })
      app.log.info({ tokenHash: token, metric, level, action: 'skipped_muted' })
      return { success: true, muted: true }
    }

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
        data: buildAlertData({ metric, level, value, host, server_name, timestamp }, token),
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
