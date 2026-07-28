import { getAllFeatureFlags } from '../services/featureFlags.js'

// Flags are stored/managed as camelCase (matches the admin panel's naming
// convention), but the public response uses snake_case keys.
function toSnakeCase(key) {
  return key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)
}

export async function featureRoutes(app) {
  // GET /features — public feature-flag map the app reads at launch to
  // decide what to show (ads, AI agent, etc). No auth: this is global
  // config, not user-specific, and must be readable before any JWT exists.
  app.get('/features', async () => {
    const flags = await getAllFeatureFlags()
    const features = {}
    for (const [key, value] of Object.entries(flags)) {
      features[toSnakeCase(key)] = value
    }
    return { success: true, features }
  })
}
