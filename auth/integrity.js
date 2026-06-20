import { GoogleAuth } from 'google-auth-library'

const _auths = []  // ordered list of GoogleAuth instances to try

export function initAuth(...serviceAccounts) {
  for (const sa of serviceAccounts) {
    if (!sa) continue
    _auths.push(new GoogleAuth({
      credentials: sa,
      scopes: ['https://www.googleapis.com/auth/playintegrity']
    }))
  }
}

async function decodeWithAuth(googleAuth, integrityToken, packageName) {
  const client = await googleAuth.getClient()
  const { token } = await client.getAccessToken()
  const email = client.email ?? client.credentials?.client_email ?? 'unknown'

  console.info('[integrity] trying', { packageName, serviceAccount: email })

  const res = await fetch(
    `https://playintegrity.googleapis.com/v1/${packageName}:decodeIntegrityToken`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ integrity_token: integrityToken })
    }
  )

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    const err = new Error(body?.error?.message ?? `Play Integrity API error ${res.status}`)
    err.status = res.status
    err.serviceAccount = email
    console.warn('[integrity] attempt failed', { serviceAccount: email, status: res.status, message: err.message })
    throw err
  }

  return { verdict: await res.json(), serviceAccount: email }
}

export async function verifyIntegrityToken(integrityToken, packageName) {
  let lastErr
  for (const googleAuth of _auths) {
    try {
      const { verdict, serviceAccount } = await decodeWithAuth(googleAuth, integrityToken, packageName)
      console.info('[integrity] success', {
        packageName,
        serviceAccount,
        appRecognition: verdict?.tokenPayloadExternal?.appIntegrity?.appRecognitionVerdict,
        deviceRecognition: verdict?.tokenPayloadExternal?.deviceIntegrity?.deviceRecognitionVerdict
      })
      return verdict
    } catch (err) {
      lastErr = err
      if (err.status !== 403) break  // only retry on 403 (not authorized) — other errors are not recoverable
    }
  }
  throw lastErr
}

export function checkVerdicts(verdict) {
  const appRecognition = verdict?.tokenPayloadExternal?.appIntegrity?.appRecognitionVerdict
  const deviceRecognition = verdict?.tokenPayloadExternal?.deviceIntegrity?.deviceRecognitionVerdict ?? []

  const appOk = appRecognition === 'PLAY_RECOGNIZED' || appRecognition === 'UNRECOGNIZED_VERSION'
  if (!appOk) {
    return { ok: false, error: 'App failed integrity check', appRecognition, deviceRecognition }
  }

  const deviceOk = deviceRecognition.some(v =>
    v === 'MEETS_BASIC_INTEGRITY' || v === 'MEETS_DEVICE_INTEGRITY' || v === 'MEETS_STRONG_INTEGRITY'
  )
  if (!deviceOk) {
    return { ok: false, error: 'Device does not meet integrity requirements', appRecognition, deviceRecognition }
  }

  return { ok: true, appRecognition, deviceRecognition }
}
