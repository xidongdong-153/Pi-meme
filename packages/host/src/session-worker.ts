import { create as createGoals } from '@pi-meme/goals/agent/entry'
import { create as createActivities } from '@pi-meme/activities/agent/entry'
import { runSessionWorker } from '@pi-meme/pi-adapter/session-worker'
import { create as createPermissions } from '@pi-meme/permissions/agent/entry'
import { create as createSandboxMacos } from '@pi-meme/sandbox-macos/agent/entry'
import { create as createSandboxLinux } from '@pi-meme/sandbox-linux/agent/entry'
import { sandboxPluginId } from './sandbox-platform'
import { create as createResources } from '@pi-meme/resources/agent/entry'
import { create as createInteraction } from '@pi-meme/interaction/agent/entry'
import { create as createCodemode } from '@pi-meme/codemode/agent/entry'
import { create as createImageGeneration } from '@pi-meme/image-generation/agent/entry'
import { create as createMcp } from '@pi-meme/mcp/agent/entry'
import { create as createSubagents } from '@pi-meme/subagents/agent/entry'

runSessionWorker({
  '@pi-meme/goals': createGoals,
  '@pi-meme/activities': createActivities,
  '@pi-meme/permissions': createPermissions,
  [sandboxPluginId()]: sandboxPluginId() === '@pi-meme/sandbox-linux' ? createSandboxLinux : createSandboxMacos,
  '@pi-meme/resources': createResources,
  '@pi-meme/interaction': createInteraction,
  '@pi-meme/codemode': createCodemode,
  '@pi-meme/mcp': createMcp,
  '@pi-meme/image-generation': createImageGeneration,
  '@pi-meme/subagents': createSubagents,
})
