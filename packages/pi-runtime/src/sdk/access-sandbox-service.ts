import type { BuiltinModuleContext } from '@pi-meme/contracts/builtin-module'
import {
  AccessSandbox,
  probeAccessSandbox,
  type AccessSandboxOperations,
  type AccessSandboxOptions,
} from './access-sandbox'

/** 平台入口只声明装配信息，实际探测、创建和释放使用同一条路径。 */
export async function registerAccessSandbox(context: Pick<BuiltinModuleContext, 'provide' | 'onDispose'>) {
  const capability = await probeAccessSandbox()
  if (!capability.supported) console.error(capability.reason)
  const running = new Set<AccessSandboxOperations>()
  const pending = new Set<Promise<AccessSandboxOperations>>()
  let disposed = false
  context.provide('agent.sandbox', {
    available: () => !disposed && capability.supported,
    capability: () => ({ ...capability }),
    create: async (options: AccessSandboxOptions) => {
      if (disposed) throw new Error('受限权限沙箱服务已释放')
      if (!capability.supported) throw new Error(capability.reason ?? '受限权限沙箱不可用')
      const creation = AccessSandbox.create(options)
      pending.add(creation)
      try {
        const sandbox = await creation
        if (disposed) {
          await sandbox.stopAll()
          throw new Error('受限权限沙箱服务已释放')
        }
        running.add(sandbox)
        return sandbox
      } finally {
        pending.delete(creation)
      }
    },
  })
  context.onDispose(async () => {
    disposed = true
    await Promise.allSettled([...pending])
    const results = await Promise.allSettled([...running].map((sandbox) => sandbox.stopAll()))
    running.clear()
    const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason)
    if (failures.length) throw new AggregateError(failures, '受限权限沙箱释放失败')
  })
}
