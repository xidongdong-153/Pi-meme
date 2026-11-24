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
  acquireMcpRefreshLock: import('@pi-meme/contracts/mcp').AcquireMcpRefreshLock
  registerMcpReferences: (validate: (refs: import('@pi-meme/contracts/mcp').McpReference[]) => void) => void
}): InlineExtension[] {
  return [
    createDesktopMcpExtension(
      context.sdk,
      context.paths,
      context.credentials,
      context.settings.mcpEnabled === false,
      context.registerMcpReferences,
      context.acquireMcpRefreshLock,
    ),
    { name: 'pi-meme-tool-search', factory: context.sdk.createToolSearchExtension() },
  ]
}
