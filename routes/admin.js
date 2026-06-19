import { admin, db } from '../firebase.js'
import { getSettings, updateSettings } from '../services/settings.js'
import { adminHTML } from '../views/adminDashboard.js'
import { getEnv } from '../config.js'

const TOKENS = 'integrationTokens'

function ts(firestoreTs) {
  return firestoreTs?.toDate?.()?.toISOString() ?? null
}

function isAuthorized(request) {
  const adminToken = getEnv('ADMIN_TOKEN')
  return adminToken && request.query.token === adminToken
}

export async function adminRoutes(app) {
  // GET /admin — protected admin dashboard
  app.get('/admin', async (request, reply) => {
    if (!isAuthorized(request)) {
      return reply.code(401).type('text/plain').send('Unauthorized')
    }

    const [snapshot, settings] = await Promise.all([
      db.collection(TOKENS).orderBy('createdAt', 'desc').get(),
      getSettings()
    ])

    const tokens = snapshot.docs.map(doc => {
      const d = doc.data()
      return {
        hash: doc.id,
        fcmToken: d.fcmToken ?? '',
        packageName: d.packageName ?? null,
        hitCount: d.hitCount ?? 0,
        createdAt: ts(d.createdAt),
        revokedAt: ts(d.revokedAt),
        lastSeenAt: ts(d.lastSeenAt)
      }
    })

    return reply.type('text/html').send(adminHTML(tokens, settings, getEnv('ADMIN_TOKEN')))
  })

  // POST /admin/settings — update server settings
  app.post('/admin/settings', async (request, reply) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }

    const { skipDebugPackages } = request.body ?? {}
    if (typeof skipDebugPackages !== 'boolean') {
      return reply.code(400).send({ error: 'skipDebugPackages must be a boolean' })
    }

    await updateSettings({ skipDebugPackages })
    app.log.info({ action: 'settings_updated', skipDebugPackages })
    return { success: true, settings: { skipDebugPackages } }
  })
}
