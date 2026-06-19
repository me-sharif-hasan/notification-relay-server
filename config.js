import { readFileSync } from 'fs'

const env = {}
try {
  readFileSync('./.env', 'utf8').split('\n').forEach(line => {
    const [k, ...v] = line.split('=')
    if (k && !k.startsWith('#')) env[k.trim()] = v.join('=').trim()
  })
} catch {}

export const getEnv = k => process.env[k] ?? env[k]

export const TOKEN_LIMIT_FREE    = 50_000
export const TOKEN_LIMIT_PREMIUM = 500_000
export const DEEPSEEK_BASE = 'https://api.deepseek.com'

export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

export function rateLimitConfig() {
  return {
    requestsPerMin:  Number(getEnv('RATE_LIMIT_REQUESTS_PER_MIN')  ?? 10),
    requestsPerDay:  Number(getEnv('RATE_LIMIT_REQUESTS_PER_DAY')  ?? 200),
    tokensPerDay:    Number(getEnv('RATE_LIMIT_TOKENS_PER_DAY')    ?? 500_000),
    tasksPerMonth:   Number(getEnv('RATE_LIMIT_TASKS_PER_MONTH')   ?? 50),
  }
}
