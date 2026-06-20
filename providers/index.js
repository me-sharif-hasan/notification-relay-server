import * as gemini from './gemini.js'
import * as deepseek from './deepseek.js'

const registry = { gemini, deepseek }

export function getProvider(name) {
  return registry[name] ?? registry.gemini
}
