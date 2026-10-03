import { createHash } from 'crypto'

/**
 * FCM data payload for an alert. Every value is a string (FCM requirement).
 * `token_id` is a hash of the integration token, so the app can tell which of
 * its servers an alert belongs to without the secret token leaving the relay.
 */
export function buildAlertData({ metric, level, value, host, server_name, timestamp }, token, now = new Date()) {
  return {
    metric: String(metric ?? ''),
    level: String(level ?? ''),
    value: String(value ?? ''),
    host: String(host ?? ''),
    server_name: String(server_name ?? ''),
    token_id: createHash('sha256').update(token).digest('hex'),
    timestamp: String(timestamp ?? now.toISOString())
  }
}
