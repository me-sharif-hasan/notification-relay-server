import { requireJwt } from '../middleware/requireJwt.js'
import {
  getMonthlyTasks,
  incrementMonthlyTasks,
  getDailyRequests,
  getDailyTokens,
  resetsAtMidnight,
  resetsAtMonthStart
} from '../services/rateLimitFirestore.js'
import { generateTaskId, createTask } from '../services/agentTasks.js'
import { rateLimitConfig } from '../config.js'

export async function subscriptionRoutes(app) {
  // POST /api/agent/task/start — reserve a task slot before the first LLM call
  app.post('/api/agent/task/start', { preHandler: requireJwt }, async (request, reply) => {
    const { sub, plan } = request.jwtPayload

    if (plan !== 'subscriber' && plan !== 'subscriber_discounted') {
      return reply.code(403).send({ error: 'subscription_required' })
    }

    const { tasksPerMonth } = rateLimitConfig()
    const tasksUsed = await getMonthlyTasks(sub)

    if (tasksUsed >= tasksPerMonth) {
      return reply.code(429).send({
        error: 'task_limit_reached',
        tasksUsedThisMonth: tasksUsed,
        tasksLimit: tasksPerMonth,
        resetsAt: resetsAtMonthStart()
      })
    }

    const taskId = generateTaskId()
    await createTask(taskId, sub, request.body?.description)

    return {
      taskId,
      tasksUsedThisMonth: tasksUsed,
      tasksLimit: tasksPerMonth,
      resetsAt: resetsAtMonthStart()
    }
  })

  // GET /api/subscription/status — current plan + usage for subscriber UI
  app.get('/api/subscription/status', { preHandler: requireJwt }, async (request, reply) => {
    const { sub, plan, expiryTime } = request.jwtPayload

    if (plan === 'free' || plan === 'iap') {
      return { plan }
    }

    const limits = rateLimitConfig()
    const [requestsToday, tokensToday, tasksThisMonth] = await Promise.all([
      getDailyRequests(sub),
      getDailyTokens(sub),
      getMonthlyTasks(sub)
    ])

    return {
      plan,
      expiryTime: expiryTime ? new Date(expiryTime).getTime() : null,
      usage: {
        requestsToday,
        requestsLimit:    limits.requestsPerDay,
        tokensToday,
        tokensLimit:      limits.tokensPerDay,
        tasksThisMonth,
        tasksLimit:       limits.tasksPerMonth,
        dailyResetsAt:    resetsAtMidnight(),
        monthlyResetsAt:  resetsAtMonthStart()
      }
    }
  })
}
