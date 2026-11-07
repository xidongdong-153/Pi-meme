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
  accessMode?: () => import('@pi-meme/contracts/agent-access').AgentAccessMode
  planSandbox?: () => import('@pi-meme/pi-runtime/sdk/access-sandbox').AccessSandboxOperations
  executionSandbox?: () => import('@pi-meme/pi-runtime/sdk/access-sandbox').AccessSandboxOperations
  requestMcpAuthorization?: import('@pi-meme/contracts/mcp-authorization').McpAuthorizeOperation
  registerMcpTool?: (tool: import('@earendil-works/pi-coding-agent').ToolDefinition) => void
  onExecutionBoundary?: import('@pi-meme/contracts/execution-boundary').RegisterExecutionBoundary
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
            readOnly: () => context.accessMode?.() === 'read-only',
            sandbox: context.planSandbox,
            register: context.registerPlanTool,
          }
        : undefined,
      context.executionSandbox,
      context.requestMcpAuthorization,
      context.registerMcpTool,
      context.onExecutionBoundary,
    ),
    { name: 'pi-meme-tool-search', factory: context.sdk.createToolSearchExtension() },
  ]
}
