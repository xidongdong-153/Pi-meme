import type { InlineExtension } from '@earendil-works/pi-coding-agent'
import type { DesktopSettings } from '@pi-meme/contracts/settings'
import type { PiRuntimePaths } from '@pi-meme/pi-runtime/runtime-paths'
import type { SecureCredentialStorage } from '@pi-meme/contracts/secure-storage'
import { createDesktopMcpExtension } from '../server/runtime-config'

export function create(context: {
  sdk: typeof import('@earendil-works/pi-coding-agent')
  paths: PiRuntimePaths
  credentials: SecureCredentialStorage
  settings: DesktopSettings
  cwd: string
  taskMode?: () => import('@pi-meme/contracts/plan').TaskMode
  planSandbox?: () => import('@pi-meme/pi-runtime/sdk/access-sandbox').AccessSandboxOperations
  registerPlanTool?: (name: string, source: import('@pi-meme/contracts/plan').PlanToolSource) => void
}): InlineExtension[] {
  return [
    createDesktopMcpExtension(
      context.sdk,
      context.paths,
      context.credentials,
      context.cwd,
      context.settings.mcpEnabled === false,
      context.planSandbox && context.registerPlanTool
        ? {
            active: () => context.taskMode?.() === 'plan',
            sandbox: context.planSandbox,
            register: context.registerPlanTool,
          }
        : undefined,
    ),
    { name: 'pi-meme-tool-search', factory: context.sdk.createToolSearchExtension() },
  ]
}
