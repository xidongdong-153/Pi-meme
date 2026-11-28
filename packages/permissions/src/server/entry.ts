import type {
  BuiltinModuleDescriptor as PluginManifest,
  BuiltinModuleContext as ServerPluginContext,
} from '@pi-meme/contracts/builtin-module'
import type { PiRuntime } from '@pi-meme/pi-runtime/runtime'
import { agentAccessModes, isAccessRevision, isAgentAccessMode } from '@pi-meme/contracts/agent-access'
import { text } from '@pi-meme/contracts/ipc'

export const manifest: PluginManifest = {
  name: '@pi-meme/permissions',
  version: '0.1.0',
  piMeme: {
    sdkVersion: 3,
    server: 'dist/server/chord-facets.json',
    agent: 'dist/agent/entry.js',
    requires: ['host.chat', 'agent.sandbox'],
    provides: ['agent.permissions'],
  },
}
export function create(context: ServerPluginContext) {
  const { pi } = context.services.require<{ pi: PiRuntime }>('host.chat')
  const sandbox = context.services.require<{ available: () => boolean; capability: () => { reason?: string } }>(
    'agent.sandbox',
  )
  context.provide('agent.permissions', {
    modes: agentAccessModes,
    restrictedSupported: () => sandbox.available(),
  })
  context.registerHandlers({
    'pi:access-mode': (sessionKey, mode, expectedRevision) => {
      text(sessionKey)
      if (!isAgentAccessMode(mode)) throw new Error('Agent 访问权限无效')
      if (expectedRevision !== undefined && !isAccessRevision(expectedRevision)) throw new Error('会话权限修订无效')
      if (mode !== 'full-access' && !sandbox.available())
        throw new Error(sandbox.capability().reason ?? '受限权限沙箱不可用；不能启动该会话')
      return pi.setAccessMode(sessionKey, mode, expectedRevision)
    },
  })
}
