import { db } from '../firebase.js'

const SETTINGS_DOC = db.collection('settings').doc('global')

let settingsCache = null
let settingsCacheAt = 0

export async function getSettings() {
  const now = Date.now()
  if (settingsCache && now - settingsCacheAt < 30_000) return settingsCache
  const doc = await SETTINGS_DOC.get()
  settingsCache = doc.exists ? doc.data() : {}
  settingsCacheAt = now
  return settingsCache
}

export async function updateSettings(patch) {
  await SETTINGS_DOC.set(patch, { merge: true })
  settingsCache = { ...settingsCache, ...patch }
  settingsCacheAt = Date.now()
}
