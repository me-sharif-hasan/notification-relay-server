import { admin, db } from '../firebase.js'
import { getSettings, updateSettings } from '../services/settings.js'
import { adminHTML } from '../views/adminDashboard.js'
import { getEnv, rateLimitConfig, trialConfig } from '../config.js'
import { getPerMinuteSnapshot } from '../services/rateLimitMemory.js'
import { resetTrial, getAllTrialUsers } from '../services/trialUsage.js'
import { getAllDeviceTokens, getDeviceTokenCount, getDeviceFcmToken, deleteDeviceToken } from '../services/deviceTokens.js'
import { getAllFeatureFlags, isValidFeatureKey, setFeatureFlag, deleteFeatureFlag, KNOWN_FEATURE_KEYS } from '../services/featureFlags.js'

const STALE_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token'
])

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

    const [snapshot, settings, subscribers, trialUsers, deviceCount, features] = await Promise.all([
      db.collection(TOKENS).orderBy('createdAt', 'desc').get(),
      getSettings(),
      getSubscriberUsage(),
      getAllTrialUsers(),
      getDeviceTokenCount(),
      getAllFeatureFlags(),
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
    return reply.type('text/html').send(adminHTML(tokens, settings, subscribers, rateLimitConfig(), perMinute, getEnv('ADMIN_TOKEN'), trialUsers, trialConfig(), deviceCount, features, KNOWN_FEATURE_KEYS))
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

  // POST /admin/features/set — create or update a feature killswitch.
  // Key must be camelCase (e.g. interstitialAd, bannerAd, showAiAgent) —
  // this is the naming convention the app's /features consumer relies on.
  app.post('/admin/features/set', async (request, reply) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }

    const { key, enabled } = request.body ?? {}
    if (!isValidFeatureKey(key)) {
      return reply.code(400).send({ error: 'key must be a camelCase string, e.g. showAiAgent' })
    }
    if (typeof enabled !== 'boolean') {
      return reply.code(400).send({ error: 'enabled must be a boolean' })
    }

    await setFeatureFlag(key, enabled)
    app.log.info({ key, enabled, action: 'feature_flag_set' }, 'feature flag updated via admin')
    return { success: true }
  })

  // POST /admin/features/delete — remove a custom flag's override, reverting
  // it to the default (disabled). Pre-seeded keys (KNOWN_FEATURE_KEYS) simply
  // fall back to their default the next time they're read.
  app.post('/admin/features/delete', async (request, reply) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }

    const { key } = request.body ?? {}
    if (!isValidFeatureKey(key)) {
      return reply.code(400).send({ error: 'key must be a camelCase string' })
    }

    await deleteFeatureFlag(key)
    app.log.info({ key, action: 'feature_flag_deleted' }, 'feature flag deleted via admin')
    return { success: true, prefilled: KNOWN_FEATURE_KEYS.includes(key) }
  })

  // POST /admin/notifications/send — push a notification to one device
  // (pass installId) or broadcast to every registered device (omit it).
  // Gated by the same ADMIN_TOKEN as the rest of /admin, so a future
  // automated CVE-alert service can call this endpoint directly with that
  // token — this relay stays the single point of FCM distribution, the
  // caller just decides what/when/who to send to.
  app.post('/admin/notifications/send', async (request, reply) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }

    const { title, body, data, installId } = request.body ?? {}
    if (!title || !body) {
      return reply.code(400).send({ error: 'title and body are required' })
    }

    const dataPayload = {}
    if (data && typeof data === 'object') {
      for (const [k, v] of Object.entries(data)) dataPayload[k] = String(v)
    }

    const sendEnabled = getEnv('SEND_FCM') === 'true'

    // Unicast — target a single device by installId.
    if (installId) {
      const fcmToken = await getDeviceFcmToken(installId)
      if (!fcmToken) {
        return reply.code(404).send({ error: 'device not found' })
      }

      if (!sendEnabled) {
        app.log.info({ action: 'notification_unicast_dry_run', installId, title })
        return { success: true, total: 1, sent: 0, failed: 0, cleaned: 0, dryRun: true }
      }

      try {
        await admin.messaging().send({
          token: fcmToken,
          notification: { title, body },
          data: dataPayload
        })
        app.log.info({ action: 'notification_unicast', installId, title })
        return { success: true, total: 1, sent: 1, failed: 0, cleaned: 0 }
      } catch (err) {
        let cleaned = 0
        if (STALE_TOKEN_CODES.has(err.code)) {
          await deleteDeviceToken(installId)
          cleaned = 1
        }
        app.log.warn({ action: 'notification_unicast_failed', installId, err: err.message }, 'unicast send failed')
        return reply.code(502).send({ success: false, total: 1, sent: 0, failed: 1, cleaned, error: err.message })
      }
    }

    // Broadcast — every registered device.
    const devices = await getAllDeviceTokens()

    if (!sendEnabled) {
      app.log.info({ action: 'notification_broadcast_dry_run', total: devices.length, title })
      return { success: true, total: devices.length, sent: 0, failed: 0, cleaned: 0, dryRun: true }
    }

    let sent = 0
    let cleaned = 0

    for (let i = 0; i < devices.length; i += 500) {
      const batch = devices.slice(i, i + 500)
      const res = await admin.messaging().sendEachForMulticast({
        tokens: batch.map(d => d.fcmToken),
        notification: { title, body },
        data: dataPayload
      })

      await Promise.all(res.responses.map(async (r, idx) => {
        if (r.success) {
          sent++
          return
        }
        if (STALE_TOKEN_CODES.has(r.error?.code)) {
          await deleteDeviceToken(batch[idx].installId)
          cleaned++
        }
      }))
    }

    app.log.info({ action: 'notification_broadcast', total: devices.length, sent, cleaned, title })
    return { success: true, total: devices.length, sent, failed: devices.length - sent, cleaned }
  })
}
