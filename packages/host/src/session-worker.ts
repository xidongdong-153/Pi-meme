import { runSessionWorker } from '@pi-meme/pi-adapter/session-worker'
import { create as createPermissions } from '@pi-meme/permissions/agent/entry'
import { create as createSandbox } from '@pi-meme/sandbox-macos/agent/entry'
import { create as createResources } from '@pi-meme/resources/agent/entry'
import { create as createInteraction } from '@pi-meme/pi-extensions/agent/entry'
import { create as createCodemode } from '@pi-meme/codemode/agent/entry'
import { create as createMcp } from '@pi-meme/mcp/agent/entry'
import { create as createSubagents } from '@pi-meme/subagents/agent/entry'

runSessionWorker({
  '@pi-meme/permissions': createPermissions,
  '@pi-meme/sandbox-macos': createSandbox,
  '@pi-meme/resources': createResources,
  '@pi-meme/pi-extensions': createInteraction,
  '@pi-meme/codemode': createCodemode,
  '@pi-meme/mcp': createMcp,
  '@pi-meme/subagents': createSubagents,
})
