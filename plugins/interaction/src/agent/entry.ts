import type { InteractionPluginContext } from '@pi-meme/plugin-sdk/agent'

export function create(context: InteractionPluginContext) {
  context.registerInteractionPolicy(true)
  return []
}
