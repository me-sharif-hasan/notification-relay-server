import { admin } from '../../firebase.js'
import { getEnv } from '../../config.js'
import { getSettings, updateSettings } from '../settings.js'
import { getDeviceFcmToken } from '../deviceTokens.js'
import { createFirestoreStore } from './supportStore.js'
import { createSupportTelegram } from './supportTelegram.js'
import { createSupportPush } from './supportPush.js'
import { createSupportService } from './supportService.js'
import { createOwnerBridge } from './supportOwnerBridge.js'
import { createRetention } from './supportRetention.js'

let instance = null

const getOwnerId = async () => getEnv('TELEGRAM_CHAT_ID') ?? ''

async function getSupportChatId() {
  const fromEnv = getEnv('TELEGRAM_SUPPORT_CHAT_ID')
  if (fromEnv) return fromEnv
  const settings = await getSettings()
  return settings.supportChatId ?? null
}

const setSupportChatId = chatId => updateSettings({ supportChatId: String(chatId) })

// One set of real collaborators shared by the HTTP routes, the Telegram
// webhook and the retention job.
export function getSupport() {
  if (instance) return instance
  const store = createFirestoreStore()
  const telegram = createSupportTelegram({ store, getSupportChatId, getOwnerChatId: getOwnerId })
  const push = createSupportPush({
    send: message => admin.messaging().send(message),
    getFcmToken: getDeviceFcmToken
  })
  const service = createSupportService({ store, telegram, push, getSupportChatId })
  const bridge = createOwnerBridge({ store, telegram, service, getSupportChatId, setSupportChatId, getOwnerId })
  const retention = createRetention({
    store,
    telegram,
    getSupportChatId,
    days: Number(getEnv('SUPPORT_RETENTION_DAYS')) || 365
  })
  instance = { store, telegram, push, service, bridge, retention }
  return instance
}
