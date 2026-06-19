import admin from 'firebase-admin'
import { readFileSync } from 'fs'

export const serviceAccount = JSON.parse(readFileSync('./serviceaccount.json', 'utf8'))

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) })

export { admin }
export const db = admin.firestore()
