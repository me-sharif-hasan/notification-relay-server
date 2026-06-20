import { createHash } from 'crypto'
import { verifyIntegrityToken, checkVerdicts } from '../auth/integrity.js'
import { signJwt } from '../auth/jwt.js'
import { getSettings } from '../services/settings.js'
import { verifySubscription, verifyIAP } from '../services/subscription.js'
import { getEnv } from '../config.js'

function ptHash(token) {
  return createHash('sha256').update(token).digest('hex')
}

function derivePlan(subValid, iapValid) {
  if (subValid && iapValid) return 'subscriber_discounted'
  if (subValid)             return 'subscriber'
  if (iapValid)             return 'iap'
  return 'free'
}

function deriveOfferToken(plan) {
  if (plan === 'iap')  return getEnv('PLAY_OFFER_TOKEN_DISCOUNTED') ?? null
  if (plan === 'free') return getEnv('PLAY_OFFER_TOKEN_FULL') ?? null
  return null
}

export async function authRoutes(app) {
  // POST /api/auth/integrity-token
  // Accepts both old shape (deviceId) and new shape (iapPurchaseToken / subscriptionPurchaseToken).
  // Old clients receive { success, token, expiresIn } plus the new fields — unknown fields are ignored.
  app.post('/api/auth/integrity-token', async (request, reply) => {
    const {
      integrityToken,
      packageName,
      deviceId,                   // legacy
      iapPurchaseToken,           // new
      subscriptionPurchaseToken   // new
    } = request.body ?? {}

    app.log.info({
      action: 'auth_request',
      packageName,
      deviceId,
      hasIntegrityToken: !!integrityToken,
      integrityTokenLength: integrityToken?.length,
      hasIapPurchaseToken: !!iapPurchaseToken,
      hasSubscriptionPurchaseToken: !!subscriptionPurchaseToken
    })

    if (!integrityToken || !packageName) {
      return reply.code(400).send({ success: false, error: 'integrityToken and packageName are required' })
    }

    const settings = await getSettings()

    // Debug bypass — grants subscriber plan so all features can be tested
    if (packageName.endsWith('.debug') && settings.skipDebugPackages) {
      const sub = subscriptionPurchaseToken ? ptHash(subscriptionPurchaseToken)
        : iapPurchaseToken ? ptHash(iapPurchaseToken)
        : (deviceId ?? 'debug')
      const token = signJwt({ sub, plan: 'subscriber', appRecognition: 'DEBUG_BYPASS' }, getEnv('JWT_SECRET'))
      app.log.info({ packageName, sub, action: 'jwt_issued_debug_bypass' })
      return { success: true, token, expiresIn: 900, plan: 'subscriber', offerToken: null }
    }

    // Legacy clients only send deviceId — require it if no purchase tokens
    if (!deviceId && !subscriptionPurchaseToken && !iapPurchaseToken) {
      return reply.code(400).send({ success: false, error: 'integrityToken, packageName and deviceId are required' })
    }

    let verdict
    try {
      verdict = await verifyIntegrityToken(integrityToken, packageName)
    } catch (err) {
      app.log.error(err, 'play integrity verify failed')
      return reply.code(500).send({ success: false, error: err.message })
    }

    const check = checkVerdicts(verdict)
    if (!check.ok) {
      return reply.code(400).send({
        success: false,
        error: 'integrity_failed',
        verdict: check.appRecognition
      })
    }

    // New path: verify purchase tokens and derive plan
    if (subscriptionPurchaseToken || iapPurchaseToken) {
      let subValid = false, iapValid = false, expiryTime = null

      if (subscriptionPurchaseToken) {
        try {
          const result = await verifySubscription(subscriptionPurchaseToken)
          subValid = result.valid
          expiryTime = result.expiryTime
        } catch (err) {
          app.log.warn({ err: err.message }, 'subscription verification failed — treating as invalid')
        }
      }

      if (iapPurchaseToken) {
        try {
          const result = await verifyIAP(iapPurchaseToken)
          iapValid = result.valid
        } catch (err) {
          app.log.warn({ err: err.message }, 'IAP verification failed — treating as invalid')
        }
      }

      const plan       = derivePlan(subValid, iapValid)
      const offerToken = deriveOfferToken(plan)
      const sub        = subscriptionPurchaseToken ? ptHash(subscriptionPurchaseToken) : ptHash(iapPurchaseToken)

      const token = signJwt({ sub, plan, appRecognition: check.appRecognition, expiryTime }, getEnv('JWT_SECRET'))
      app.log.info({ sub, plan, appRecognition: check.appRecognition, action: 'jwt_issued' })
      return { success: true, token, expiresIn: 900, plan, offerToken }
    }

    // Legacy path: deviceId only, no purchase tokens — always free plan
    const token = signJwt(
      { sub: deviceId, plan: 'free', deviceId, appRecognition: check.appRecognition },
      getEnv('JWT_SECRET')
    )
    app.log.info({ packageName, deviceId, appRecognition: check.appRecognition, action: 'jwt_issued_legacy' })
    return { success: true, token, expiresIn: 900, plan: 'free', offerToken: deriveOfferToken('free') }
  })
}
