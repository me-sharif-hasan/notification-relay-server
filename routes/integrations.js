import { createHash } from 'crypto'
import { admin, db } from '../firebase.js'

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
}
