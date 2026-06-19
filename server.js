import Fastify from 'fastify'
import { initAuth } from './auth/integrity.js'
import { serviceAccount } from './firebase.js'
import { getEnv } from './config.js'
import { authRoutes } from './routes/auth.js'
import { chatRoutes } from './routes/chat.js'
import { subscriptionRoutes } from './routes/subscription.js'
import { playNotificationRoutes } from './routes/playNotifications.js'
import { integrationRoutes } from './routes/integrations.js'
import { alertRoutes } from './routes/alert.js'
import { adminRoutes } from './routes/admin.js'

initAuth(serviceAccount)

const app = Fastify({ logger: true })

app.register(authRoutes)
app.register(chatRoutes)
app.register(subscriptionRoutes)
app.register(playNotificationRoutes)
app.register(integrationRoutes)
app.register(alertRoutes)
app.register(adminRoutes)

app.listen({ port: Number(getEnv('PORT')) || 3000, host: '0.0.0.0' })
