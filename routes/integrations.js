import { createHash } from 'crypto'
import { admin, db } from '../firebase.js'
import { isRateLimited } from '../services/rateLimitMemory.js'
import { muteStatus, parseMuteRequest } from '../services/muteState.js'

const TOKENS = 'integrationTokens'

export async function integrationRoutes(app) {
  // POST /integrations/token — create integration token
  app.post('/integrations/token', async (request, reply) => {
    const { integrityToken, fcmToken, packageName } = request.body ?? {}
    if (!integrityToken || !fcmToken) {
      return reply.code(400).send({ error: 'integrityToken and fcmToken are required' })
    }

    const tokenHash = createHash('sha256').update(integrityToken + fcmToken).digest('hex')

    const doc = {
      fcmToken,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      revokedAt: null,
      lastSeenAt: null
    }
    if (packageName) doc.packageName = packageName

    await db.collection(TOKENS).doc(tokenHash).set(doc)

    app.log.info({ tokenHash, packageName: packageName ?? null, action: 'created' })
    return { token: tokenHash, createdAt: new Date().toISOString() }
  })

  // DELETE /integrations/token — revoke a token
  app.delete('/integrations/token', async (request, reply) => {
    const { token } = request.body ?? {}
    if (!token) return reply.code(400).send({ error: 'token is required' })

    const docRef = db.collection(TOKENS).doc(token)
    const doc = await docRef.get()

    if (!doc.exists) {
      return reply.code(404).send({ error: 'Token not found' })
    }

    await docRef.update({ revokedAt: admin.firestore.FieldValue.serverTimestamp() })

    app.log.info({ tokenHash: token, action: 'revoked' })
    return { success: true }
  })

  // Resolves the token document for the mute routes, or replies with the error.
  async function activeTokenDoc(request, reply) {
    const { token } = request.body ?? {}
    if (!token || typeof token !== 'string') {
      reply.code(400).send({ error: 'token is required' })
      return null
    }
    if (isRateLimited(`mute:${token}`, 30)) {
      reply.code(429).send({ error: 'Rate limited' })
      return null
    }
    const docRef = db.collection(TOKENS).doc(token)
    const doc = await docRef.get()
    if (!doc.exists) {
      reply.code(404).send({ error: 'Token not found' })
      return null
    }
    if (doc.data().revokedAt !== null) {
      reply.code(401).send({ error: 'Invalid or revoked token' })
      return null
    }
    return { docRef, data: doc.data() }
  }

  // POST /integrations/token/status — whether alerts for this token are muted
  app.post('/integrations/token/status', async (request, reply) => {
    const found = await activeTokenDoc(request, reply)
    if (!found) return
    return muteStatus(found.data)
  })

  // POST /integrations/token/mute — mute alerts for { minutes } or { indefinite: true }
  app.post('/integrations/token/mute', async (request, reply) => {
    const found = await activeTokenDoc(request, reply)
    if (!found) return
    const parsed = parseMuteRequest(request.body)
    if (parsed.error) return reply.code(400).send({ error: parsed.error })

    const update = { mutedUntil: parsed.mutedUntil, mutedIndefinitely: parsed.mutedIndefinitely }
    await found.docRef.update(update)

    app.log.info({ tokenHash: request.body.token, action: 'muted', indefinite: parsed.mutedIndefinitely })
    return muteStatus(update)
  })

  // DELETE /integrations/token/mute — resume alerts
  app.delete('/integrations/token/mute', async (request, reply) => {
    const found = await activeTokenDoc(request, reply)
    if (!found) return
    await found.docRef.update({ mutedUntil: null, mutedIndefinitely: false })

    app.log.info({ tokenHash: request.body.token, action: 'unmuted' })
    return muteStatus({})
  })
}
