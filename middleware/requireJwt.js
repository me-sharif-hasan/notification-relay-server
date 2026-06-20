import { verifyJwt } from '../auth/jwt.js'
import { getEnv } from '../config.js'

export async function requireJwt(request, reply) {
  const auth = request.headers.authorization
  if (!auth?.startsWith('Bearer ')) {
    return reply.code(401).send({ success: false, error: 'Missing Bearer token' })
  }
  try {
    request.jwtPayload = verifyJwt(auth.slice(7), getEnv('JWT_SECRET'))
  } catch (err) {
    request.log.warn({ jwtError: err.name, jwtMessage: err.message }, 'JWT verification failed')
    return reply.code(401).send({ success: false, error: 'Invalid or expired token' })
  }
}
