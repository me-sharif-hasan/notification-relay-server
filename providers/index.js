import * as gemini from './gemini.js'
import * as deepseek from './deepseek.js'

const registry = { gemini, deepseek }

export const ALLOWED_MODELS = new Set([
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-2.0-flash',
  'deepseek-chat',
  'deepseek-reasoner',
])

// Select provider by admin-configured name ('gemini' | 'deepseek')
export function getProvider(name) {
  return registry[name] ?? registry.gemini
}

// Select provider by model name sent in the request body.
// Returns { provider, model } — model is passed through to the provider
// so it uses the specific variant the client requested.
// Caller must validate against ALLOWED_MODELS before calling this.
export function getProviderForModel(modelName) {
  if (!modelName) return null
  if (modelName.startsWith('gemini-'))   return { provider: gemini,   model: modelName }
  if (modelName.startsWith('deepseek-')) return { provider: deepseek, model: modelName }
  return null
}
