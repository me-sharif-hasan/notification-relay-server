import { GoogleAuth } from 'google-auth-library'
import { serviceAccount } from '../firebase.js'
import { getEnv } from '../config.js'

const auth = new GoogleAuth({
  credentials: serviceAccount,
  scopes: ['https://www.googleapis.com/auth/androidpublisher']
})

async function getToken() {
  const client = await auth.getClient()
  const { token } = await client.getAccessToken()
  return token
}

// Verifies an active subscription via androidpublisher v3 subscriptionsv2.
// Returns { valid, subscriptionState, expiryTime }
export async function verifySubscription(purchaseToken) {
  const packageName = getEnv('GOOGLE_PLAY_PACKAGE_NAME')
  const token = await getToken()

  const res = await fetch(
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${packageName}/purchases/subscriptionsv2/tokens/${purchaseToken}`,
    { headers: { Authorization: `Bearer ${token}` } }
  )

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body?.error?.message ?? `AndroidPublisher subscriptions API error ${res.status}`)
  }

  const data = await res.json()
  const state = data?.subscriptionState
  return {
    valid: state === 'SUBSCRIPTION_STATE_ACTIVE' || state === 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
    subscriptionState: state,
    expiryTime: data?.lineItems?.[0]?.expiryTime ?? null  // ISO string
  }
}

// Verifies a one-time IAP purchase via androidpublisher v3 products.
// Returns { valid, purchaseState }
export async function verifyIAP(purchaseToken) {
  const packageName = getEnv('GOOGLE_PLAY_PACKAGE_NAME')
  const productId  = getEnv('PLAY_IAP_PRODUCT_ID')
  const token = await getToken()

  const res = await fetch(
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${packageName}/purchases/products/${productId}/tokens/${purchaseToken}`,
    { headers: { Authorization: `Bearer ${token}` } }
  )

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body?.error?.message ?? `AndroidPublisher products API error ${res.status}`)
  }

  const data = await res.json()
  return {
    valid: data?.purchaseState === 0,
    purchaseState: data?.purchaseState
  }
}
