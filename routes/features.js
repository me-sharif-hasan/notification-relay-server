import { getAllFeatureFlags } from '../services/featureFlags.js'

export async function featureRoutes(app) {
  // GET /features — public feature-flag map the app reads at launch to
  // decide what to show (ads, AI agent, etc). No auth: this is global
  // config, not user-specific, and must be readable before any JWT exists.
  app.get('/features', async () => {
    return { success: true, features: await getAllFeatureFlags() }
  })
}
