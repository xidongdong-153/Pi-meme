import type {
  BuiltinModuleDescriptor as PluginManifest,
  BuiltinModuleContext as ServerPluginContext,
} from '@pi-meme/contracts/builtin-module'
import {
  AccessSandbox,
  probeAccessSandbox,
  executionCapabilityReport,
  type SandboxCapability,
  type AccessSandboxOperations,
  type AccessSandboxOptions,
} from '@pi-meme/pi-runtime/sdk/access-sandbox'

export const manifest: PluginManifest = {
  name: '@pi-meme/sandbox-windows',
  version: '0.1.0',
  piMeme: {
    sdkVersion: 3,
    server: 'dist/server/chord-facets.json',
    agent: 'dist/agent/entry.js',
    provides: ['agent.sandbox'],
  },
}
export async function create(context: ServerPluginContext) {
  let capability: SandboxCapability = {
    supported: false,
    reason: '沙箱能力正在探测',
    report: executionCapabilityReport(false),
  }
  const controller = new AbortController()
  const ready = probeAccessSandbox({ signal: controller.signal }).then((result) => {
    capability = result
    return result
  })
  const running = new Set<AccessSandboxOperations>()
  context.provide('agent.sandbox', {
    available: () => capability.supported,
    capability: () => structuredClone(capability),
    create: async (options: AccessSandboxOptions) => {
      await ready
      if (controller.signal.aborted) throw new Error('沙箱服务已释放')
      if (!capability.supported) throw new Error(capability.reason ?? '受限权限沙箱不可用')
      const sandbox = await AccessSandbox.create({
        ...options,
        signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal,
      })
      if (controller.signal.aborted) {
        await sandbox.stopAll()
        throw new Error('沙箱服务已释放')
      }
      running.add(sandbox)
      return sandbox
    },
  })
  context.onDispose(async () => {
    controller.abort()
    await Promise.allSettled([...running].map((sandbox) => sandbox.stopAll()))
    running.clear()
  })
}
