import { createHash } from 'crypto'

export const KINDS = ['problem', 'question', 'idea']
export const MAX_TEXT = 2000
export const MAX_IMAGES = 3
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024
export const MAX_LOG_CHARS = 60_000
export const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp']

const INSTALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CONTEXT_FIELDS = [
  'appVersion', 'appBuild', 'buildType', 'installer', 'androidVersion', 'sdk', 'device', 'abi',
  'ramBucket', 'freeStorage', 'locale', 'timezone', 'networkType', 'labs', 'serverKind', 'serverOs', 'lastError'
]

export class SupportError extends Error {
  constructor(status, code) {
    super(code)
    this.status = status
    this.code = code
  }
}

// Two-letter country from Cloudflare's header; never the IP itself.
export function parseCountry(headerValue) {
  const code = typeof headerValue === 'string' ? headerValue.trim().toUpperCase() : ''
  return /^[A-Z]{2}$/.test(code) && code !== 'XX' && code !== 'T1' ? code : 'unknown'
}

export function isInstallId(value) {
  return typeof value === 'string' && INSTALL_ID.test(value)
}

// Short, non-reversible label shown to the developer; never the install id itself.
export function shortId(installId) {
  return createHash('sha256').update(installId).digest('hex').slice(0, 4)
}

export function normalizeKind(kind) {
  return KINDS.includes(kind) ? kind : 'problem'
}

const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[private key removed]'],
  [/\b(password|passwd|pwd|passphrase|secret|api[_-]?key|token)(\s*[:=]\s*)\S+/gi, '$1$2[removed]'],
  [/(\bBearer\s+)[A-Za-z0-9._~+/=-]{16,}/g, '$1[removed]'],
  [/(sshpass\s+-p\s*)\S+/gi, '$1[removed]']
]

export function redactSecrets(text) {
  return SECRET_PATTERNS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), String(text ?? ''))
}

// Logs get the stricter pass: addresses and mail addresses are masked too.
export function redactLog(text) {
  return redactSecrets(text)
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]')
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]')
}

function cleanLine(value, max = 120) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max)
}

export function sanitizeContext(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  for (const field of CONTEXT_FIELDS) {
    const value = raw[field]
    if (value === undefined || value === null || value === '') continue
    if (!['string', 'number', 'boolean'].includes(typeof value)) continue
    out[field] = field === 'lastError' ? redactSecrets(cleanLine(value, 300)) : cleanLine(value)
  }
  return out
}

function decodedBytes(base64) {
  const clean = base64.replace(/=+$/, '')
  return Math.floor((clean.length * 3) / 4)
}

export function validateImages(raw) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw) || raw.length > MAX_IMAGES) throw new SupportError(400, 'too_many_images')
  return raw.map((image, i) => {
    const mime = image?.mime
    const data = image?.data
    if (!IMAGE_MIMES.includes(mime) || typeof data !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(data)) {
      throw new SupportError(400, 'invalid_image')
    }
    if (decodedBytes(data) > MAX_IMAGE_BYTES) throw new SupportError(413, 'image_too_large')
    const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg'
    return { mime, buffer: Buffer.from(data, 'base64'), name: `screenshot-${i + 1}.${ext}` }
  })
}

export function validateMessage(body) {
  const installId = body?.installId
  if (!isInstallId(installId)) throw new SupportError(400, 'invalid_install_id')
  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  if (text.length > MAX_TEXT) throw new SupportError(400, 'text_too_long')
  const images = validateImages(body?.images)
  const logs = typeof body?.logs === 'string' ? redactLog(body.logs).slice(-MAX_LOG_CHARS) : ''
  if (!text && images.length === 0) throw new SupportError(400, 'empty_message')
  return {
    installId,
    text: redactSecrets(text),
    kind: normalizeKind(body?.kind),
    context: sanitizeContext(body?.context),
    images,
    logs
  }
}

export function topicTitle({ shortId: id, country, kind }) {
  const tag = kind === 'idea' ? 'Idea' : kind === 'question' ? 'Question' : 'Problem'
  const where = country && country !== 'unknown' ? country : '??'
  return `#${id} ${where} - ${tag}`.slice(0, 120)
}

export function contextSummary(context) {
  const parts = []
  if (context.appVersion) parts.push(`App ${context.appVersion}${context.appBuild ? ` (${context.appBuild})` : ''}`)
  if (context.androidVersion) parts.push(`Android ${context.androidVersion}${context.sdk ? ` / SDK ${context.sdk}` : ''}`)
  if (context.device) parts.push(context.device)
  if (context.abi) parts.push(context.abi)
  if (context.ramBucket) parts.push(`RAM ${context.ramBucket}`)
  if (context.freeStorage) parts.push(`Free ${context.freeStorage}`)
  if (context.locale) parts.push(context.locale)
  if (context.timezone) parts.push(context.timezone)
  if (context.networkType) parts.push(context.networkType)
  if (context.installer) parts.push(`Installer ${context.installer}`)
  if (context.buildType && context.buildType !== 'release') parts.push(context.buildType)
  const lines = [parts.join(' | ')]
  if (context.serverKind || context.serverOs) lines.push(`Server: ${[context.serverKind, context.serverOs].filter(Boolean).join(' ')}`)
  if (context.labs) lines.push(`Lab: ${context.labs}`)
  if (context.lastError) lines.push(`Last error: ${context.lastError}`)
  return lines.filter(Boolean).join('\n')
}

export function ownerMessageText({ shortId: id, country, kind, text, context }) {
  const lines = [topicTitle({ shortId: id, country, kind })]
  const summary = contextSummary(context)
  if (summary) lines.push(summary)
  lines.push('', text || '(images only)')
  return lines.join('\n')
}

export function previewOf(text, max = 90) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat
}

export function createWindowLimiter({ windowMs, max, now = Date.now }) {
  const hits = new Map()
  return {
    take(key) {
      const t = now()
      const entry = hits.get(key)
      if (!entry || t >= entry.resetAt) {
        hits.set(key, { count: 1, resetAt: t + windowMs })
        return true
      }
      if (entry.count >= max) return false
      entry.count++
      return true
    },
    sweep() {
      const t = now()
      for (const [key, entry] of hits) if (t >= entry.resetAt) hits.delete(key)
    }
  }
}
