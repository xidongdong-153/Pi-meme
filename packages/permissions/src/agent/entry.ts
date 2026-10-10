import { createAgentAccessExtension } from '@pi-meme/pi-runtime/extensions/agent-access'

export function create(context: { registerAccessExtension: (factory: typeof createAgentAccessExtension) => void }) {
  context.registerAccessExtension(createAgentAccessExtension)
  return []
}
