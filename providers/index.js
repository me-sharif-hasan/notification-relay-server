import * as gemini from './gemini.js'
import * as deepseek from './deepseek.js'

const registry = { gemini, deepseek }

// Select provider by admin-configured name ('gemini' | 'deepseek')
export function getProvider(name) {
  return registry[name] ?? registry.gemini
}

// Select provider by model name sent in the request body.
// Returns { provider, model } — model is passed through to the provider
// so it uses the specific variant the client requested.
export function getProviderForModel(modelName) {
  if (!modelName) return null
  if (modelName.startsWith('gemini-'))   return { provider: gemini,   model: modelName }
  if (modelName.startsWith('deepseek-')) return { provider: deepseek, model: modelName }
  return null  // unknown prefix — caller falls back to admin setting
}
