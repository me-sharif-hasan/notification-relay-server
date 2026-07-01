import { admin, db } from '../firebase.js'
import { getSettings, updateSettings } from '../services/settings.js'
import { adminHTML } from '../views/adminDashboard.js'
import { getEnv, rateLimitConfig, trialConfig } from '../config.js'
import { getPerMinuteSnapshot } from '../services/rateLimitMemory.js'
import { resetTrial, getAllTrialUsers } from '../services/trialUsage.js'

const TOKENS    = 'integrationTokens'
const BLOCKLIST = 'blocklist'

function ts(firestoreTs) {
  return firestoreTs?.toDate?.()?.toISOString() ?? null
}

function isAuthorized(request) {
  const adminToken = getEnv('ADMIN_TOKEN')
  return adminToken && request.query.token === adminToken
}

function todayStr() {
  return new Date().toISOString().split('T')[0]
}

function monthStr() {
  const d = new Date()
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

async function getSubscriberUsage() {
  const today = todayStr()
  const month = monthStr()
  const now   = new Date()

  const reqSuffix  = `_req_${today}`
  const tokSuffix  = `_tok_${today}`
  const taskSuffix = `_tasks_${month}`

  const [rlSnap, blSnap] = await Promise.all([
    db.collection('rateLimits').get(),
    db.collection(BLOCKLIST).get()
  ])

  const blocklisted = new Set(blSnap.docs.map(d => d.id))
  const users = {}

  for (const doc of rlSnap.docs) {
    const id   = doc.id
    const data = doc.data()
    if (data.expiresAt?.toDate() <= now) continue

    let ptHash, field
    if (id.endsWith(reqSuffix)) {
      ptHash = id.slice(0, -reqSuffix.length)
      field  = 'dailyRequests'
    } else if (id.endsWith(tokSuffix)) {
      ptHash = id.slice(0, -tokSuffix.length)
      field  = 'dailyTokens'
    } else if (id.endsWith(taskSuffix)) {
      ptHash = id.slice(0, -taskSuffix.length)
      field  = 'monthlyTasks'
    } else continue

    if (!users[ptHash]) users[ptHash] = { ptHash, dailyRequests: 0, dailyTokens: 0, monthlyTasks: 0 }
    users[ptHash][field] = data.count ?? 0
  }

  // Mark blocklisted users that may not have activity today
  for (const ptHash of blocklisted) {
    if (!users[ptHash]) users[ptHash] = { ptHash, dailyRequests: 0, dailyTokens: 0, monthlyTasks: 0 }
  }

  return Object.values(users)
    .map(u => ({ ...u, blocklisted: blocklisted.has(u.ptHash) }))
    .sort((a, b) => b.dailyRequests - a.dailyRequests)
}

export async function adminRoutes(app) {
  // GET /admin — protected admin dashboard
  app.get('/admin', async (request, reply) => {
    if (!isAuthorized(request)) {
      return reply.code(401).type('text/plain').send('Unauthorized')
    }

    const [snapshot, settings, subscribers, trialUsers] = await Promise.all([
      db.collection(TOKENS).orderBy('createdAt', 'desc').get(),
      getSettings(),
      getSubscriberUsage(),
      getAllTrialUsers(),
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

    const perMinute = getPerMinuteSnapshot()
    return reply.type('text/html').send(adminHTML(tokens, settings, subscribers, rateLimitConfig(), perMinute, getEnv('ADMIN_TOKEN'), trialUsers, trialConfig()))
  })

  // POST /admin/settings — update server settings
  app.post('/admin/settings', async (request, reply) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }

    const { skipDebugPackages, provider, trialPromptsMax, trialWindowDays } = request.body ?? {}
    const patch = {}
    if (typeof skipDebugPackages === 'boolean') patch.skipDebugPackages = skipDebugPackages
    if (provider === 'gemini' || provider === 'deepseek') patch.provider = provider
    if (typeof trialPromptsMax === 'number' && trialPromptsMax > 0) patch.trialPromptsMax = Math.floor(trialPromptsMax)
    if (typeof trialWindowDays === 'number' && trialWindowDays > 0) patch.trialWindowDays = Math.floor(trialWindowDays)

    if (!Object.keys(patch).length) {
      return reply.code(400).send({ error: 'no valid fields provided' })
    }

    await updateSettings(patch)
    app.log.info({ action: 'settings_updated', ...patch })
    return { success: true, settings: patch }
  })

  // POST /admin/reset-quota — reset daily and/or monthly counters for a subscriber
  app.post('/admin/reset-quota', async (request, reply) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }

    const { ptHash, scope } = request.body ?? {}
    if (!ptHash) return reply.code(400).send({ error: 'ptHash required' })

    const today = todayStr()
    const month = monthStr()
    const batch = db.batch()

    if (!scope || scope === 'daily' || scope === 'all') {
      batch.delete(db.collection('rateLimits').doc(`${ptHash}_req_${today}`))
      batch.delete(db.collection('rateLimits').doc(`${ptHash}_tok_${today}`))
    }
    if (!scope || scope === 'monthly' || scope === 'all') {
      batch.delete(db.collection('rateLimits').doc(`${ptHash}_tasks_${month}`))
    }

    await batch.commit()
    app.log.info({ ptHash, scope: scope ?? 'all', action: 'quota_reset' }, 'quota reset via admin')
    return { success: true }
  })

  // POST /admin/reset-trial — wipe a free user's trial window so they start fresh
  app.post('/admin/reset-trial', async (request, reply) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }
    const { identity } = request.body ?? {}
    if (!identity) return reply.code(400).send({ error: 'identity required' })
    await resetTrial(identity)
    app.log.info({ identity, action: 'trial_reset' }, 'trial reset via admin')
    return { success: true }
  })

  // POST /admin/blocklist — block or unblock a subscriber
  app.post('/admin/blocklist', async (request, reply) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }

    const { ptHash, action } = request.body ?? {}
    if (!ptHash || (action !== 'block' && action !== 'unblock')) {
      return reply.code(400).send({ error: 'ptHash and action (block|unblock) required' })
    }

    if (action === 'block') {
      await db.collection(BLOCKLIST).doc(ptHash).set({ blockedAt: admin.firestore.FieldValue.serverTimestamp() })
      app.log.warn({ ptHash, action: 'admin_blocked' }, 'subscriber blocked via admin')
    } else {
      await db.collection(BLOCKLIST).doc(ptHash).delete()
      app.log.info({ ptHash, action: 'admin_unblocked' }, 'subscriber unblocked via admin')
    }

    return { success: true }
  })
}
