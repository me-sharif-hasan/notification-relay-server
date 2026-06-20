import { requireJwt } from '../middleware/requireJwt.js'
import { checkRateLimit } from '../services/rateLimitMemory.js'
import {
  incrementDailyRequests,
  getDailyTokens,
  addDailyTokens,
  secondsUntilMidnight,
  incrementMonthlyTasks,
  decrementMonthlyTasks
} from '../services/rateLimitFirestore.js'
import { isBlocklisted } from '../services/blocklist.js'
import { getTask, claimFirstLlmCall } from '../services/agentTasks.js'
import { rateLimitConfig } from '../config.js'
import { getSettings } from '../services/settings.js'
import { getProvider, getProviderForModel, ALLOWED_MODELS } from '../providers/index.js'

export async function chatRoutes(app) {
  // GET /ping — verify active provider reachability
  app.get('/ping', { preHandler: requireJwt }, async (request, reply) => {
    const settings = await getSettings()
    const providerName = settings.provider ?? 'gemini'
    const provider = getProvider(providerName)
    try {
      await provider.ping()
      return { ok: true, provider: providerName }
    } catch (err) {
      return reply.code(err.status ?? 502).send({ ok: false, provider: providerName, error: err.message })
    }
  })

  // POST /v1/chat/completions — LLM relay with full subscription guard
  app.post('/v1/chat/completions', { preHandler: requireJwt }, async (request, reply) => {
    const { sub, plan, deviceId, isPremium } = request.jwtPayload
    const identity      = sub ?? deviceId
    const effectivePlan = plan ?? (isPremium ? 'subscriber' : 'free')
    const body          = request.body
    const isStream      = body?.stream === true
    const taskId        = request.headers['x-task-id']
    const limits        = rateLimitConfig()

    // 0. Model allowlist check (only when client explicitly sends a model)
    if (body.model != null && !ALLOWED_MODELS.has(body.model)) {
      return reply.code(400).send({
        error: 'unsupported_model',
        model: body.model,
        allowed: [...ALLOWED_MODELS]
      })
    }

    // 1. Plan check
    if (effectivePlan !== 'subscriber' && effectivePlan !== 'subscriber_discounted') {
      return reply.code(403).send({ error: 'subscription_required', plan: effectivePlan })
    }

    // 2. Blocklist check
    if (await isBlocklisted(identity)) {
      return reply.code(403).send({ error: 'subscription_revoked' })
    }

    // 3. Per-minute burst (in-memory)
    const burst = checkRateLimit(identity, limits.requestsPerMin)
    if (burst.limited) {
      request.log.warn({ identity, scope: 'minute', retryAfter: burst.retryAfter }, 'rate limit hit')
      return reply.code(429).send({ error: 'rate_limited', scope: 'minute', retry_after: burst.retryAfter })
    }

    // 4. Daily request limit
    const dayReqs = await incrementDailyRequests(identity)
    if (dayReqs > limits.requestsPerDay) {
      request.log.warn({ identity, scope: 'day_requests', dayReqs, limit: limits.requestsPerDay }, 'rate limit hit')
      return reply.code(429).send({ error: 'rate_limited', scope: 'day_requests', retry_after: secondsUntilMidnight() })
    }

    // 5. Daily token budget — check before calling provider
    const usedTokens = await getDailyTokens(identity)
    if (usedTokens >= limits.tokensPerDay) {
      request.log.warn({ identity, scope: 'day_tokens', usedTokens, limit: limits.tokensPerDay }, 'rate limit hit')
      return reply.code(429).send({ error: 'rate_limited', scope: 'day_tokens', retry_after: secondsUntilMidnight() })
    }

    // 6. Task tracking
    if (taskId) {
      const task = await getTask(taskId)
      if (!task || task.ptHash !== identity) {
        return reply.code(403).send({ error: 'invalid_task_id' })
      }
      const isFirst = await claimFirstLlmCall(taskId)
      if (isFirst) {
        const newCount = await incrementMonthlyTasks(identity)
        if (newCount > limits.tasksPerMonth) {
          await decrementMonthlyTasks(identity)
          request.log.warn({ identity, scope: 'monthly_tasks', newCount, limit: limits.tasksPerMonth }, 'rate limit hit')
          return reply.code(429).send({ error: 'task_limit_reached' })
        }
      }
    }

    // 7. Dispatch to active provider
    // If the client specifies a model name, use it to select both the provider
    // and the exact model variant. Otherwise fall back to the admin-configured provider.
    const settings      = await getSettings()
    const modelRouted   = getProviderForModel(body.model)
    const provider      = modelRouted ? modelRouted.provider : getProvider(settings.provider ?? 'gemini')
    const providerOpts  = modelRouted ? { model: modelRouted.model } : {}

    // ── Non-streaming ────────────────────────────────────────────────────────
    if (!isStream) {
      let res
      try {
        res = await provider.chat(body, providerOpts)
      } catch (err) {
        // Never forward provider 401/403 — those are upstream auth errors, not
        // client auth errors. The client would misinterpret them as a bad JWT
        // and loop endlessly refreshing its token.
        const status = (err.status === 401 || err.status === 403) ? 502 : (err.status ?? 502)
        request.log.error({ providerStatus: err.status, providerError: err.message }, 'upstream provider error')
        return reply.code(status).send({ error: 'upstream_error', detail: err.message })
      }
      addDailyTokens(identity, res.usage?.total_tokens ?? 0).catch(() => {})
      return reply.send(res)
    }

    // ── Streaming ────────────────────────────────────────────────────────────
    // Await the stream init so HTTP errors surface before we hijack the reply.
    let gen
    try {
      gen = await provider.stream(body, providerOpts)
    } catch (err) {
      const status = (err.status === 401 || err.status === 403) ? 502 : (err.status ?? 502)
      request.log.error({ providerStatus: err.status, providerError: err.message }, 'upstream provider error')
      return reply.code(status).send({ error: 'upstream_error', detail: err.message })
    }

    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    })

    let totalTokens = 0
    try {
      for await (const chunk of gen) {
        if (chunk.usage?.total_tokens) totalTokens = chunk.usage.total_tokens
        raw.write(`data: ${JSON.stringify(chunk)}\n\n`)
      }
    } catch (err) {
      app.log.error(err, 'provider stream error')
    } finally {
      raw.write('data: [DONE]\n\n')
      raw.end()
      if (totalTokens) addDailyTokens(identity, totalTokens).catch(() => {})
    }
  })
}
