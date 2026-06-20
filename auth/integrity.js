import { GoogleAuth } from 'google-auth-library'

let _googleAuth = null

export function initAuth(serviceAccount) {
  _googleAuth = new GoogleAuth({
    credentials: serviceAccount,
    scopes: ['https://www.googleapis.com/auth/playintegrity']
  })
}

export async function verifyIntegrityToken(integrityToken, packageName) {
  const client = await _googleAuth.getClient()
  const { token } = await client.getAccessToken()

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
    console.error('[integrity] API error', {
      status: res.status,
      packageName,
      integrityTokenLength: integrityToken?.length,
      errorCode: body?.error?.code,
      errorMessage: body?.error?.message,
      errorDetails: body?.error?.details
    })
    throw new Error(body?.error?.message ?? `Play Integrity API error ${res.status}`)
  }

  const verdict = await res.json()
  console.info('[integrity] API success', {
    packageName,
    appRecognition: verdict?.tokenPayloadExternal?.appIntegrity?.appRecognitionVerdict,
    deviceRecognition: verdict?.tokenPayloadExternal?.deviceIntegrity?.deviceRecognitionVerdict
  })
  return verdict
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
