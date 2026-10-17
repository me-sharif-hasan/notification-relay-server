import { getEnv } from '../../config.js'
import { previewOf } from './supportLogic.js'

export const SUPPORT_CHANNEL = 'support_replies'
const TITLE_KEY = 'support_reply_title'
const FALLBACK_TITLE = 'New reply from the developer'

export function buildReplyMessage(fcmToken, { text, seq }) {
  return {
    token: fcmToken,
    notification: { title: FALLBACK_TITLE, body: previewOf(text) },
    data: { type: 'support_reply', seq: String(seq) },
    android: {
      priority: 'high',
      notification: { channel_id: SUPPORT_CHANNEL, title_loc_key: TITLE_KEY }
    }
  }
}

// `send` and `getFcmToken` are injected so the service stays testable and
// the Firebase admin import stays out of the pure modules.
export function createSupportPush({ send, getFcmToken, enabled = () => getEnv('SEND_FCM') === 'true' }) {
  return {
    async notifyReply(installId, message) {
      if (!enabled()) return { sent: false, reason: 'disabled' }
      const fcmToken = await getFcmToken(installId)
      if (!fcmToken) return { sent: false, reason: 'no_token' }
      try {
        await send(buildReplyMessage(fcmToken, message))
        return { sent: true }
      } catch (err) {
        return { sent: false, reason: err?.code ?? 'send_failed' }
      }
    }
  }
}
