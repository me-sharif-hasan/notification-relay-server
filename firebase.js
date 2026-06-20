import admin from 'firebase-admin'
import { readFileSync, existsSync } from 'fs'

export const serviceAccount = JSON.parse(readFileSync('./serviceaccount.json', 'utf8'))

// Optional legacy service account for Play Integrity fallback
export const legacyServiceAccount = existsSync('./serviceaccount_legacy.json')
  ? JSON.parse(readFileSync('./serviceaccount_legacy.json', 'utf8'))
  : null

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) })

export { admin }
export const db = admin.firestore()
