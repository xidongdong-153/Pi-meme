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
}): InlineExtension[] {
  if (!context.settings.mcpEnabled) return []
  return [
    createDesktopMcpExtension(context.sdk, context.paths, context.credentials, context.cwd),
    context.sdk.createToolSearchExtension(),
  ]
}
