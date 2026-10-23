export const STORAGE_LAYOUT_VERSION = 2
export const STORAGE_LAYOUT_FORMAT = 'pi-meme-data' as const

export type StorageLayoutManifest = {
  format: typeof STORAGE_LAYOUT_FORMAT
  version: typeof STORAGE_LAYOUT_VERSION
  createdAt: string
  updatedAt: string
}

export const storageLayoutRelativePaths = {
  // 引导与持久身份
  manifestFile: 'storage.json',
  hostIdFile: 'host-id',
  hostLockFile: 'host.lock',

  // config
  configDirectory: 'config',
  appConfigFile: 'config/app.json',
  sshConnectionsFile: 'config/ssh-connections.json',
  profileDirectory: 'config/profile',
  profileConfigFile: 'config/profile/profile.json',
  agentDirectory: 'config/agent',
  agentSettingsFile: 'config/agent/settings.json',
  agentModelsFile: 'config/agent/models.json',
  agentMcpFile: 'config/agent/mcp.json',
  agentDeviceIdFile: 'config/agent/device-id',
  agentAgentsFile: 'config/agent/AGENTS.md',
  agentSystemFile: 'config/agent/SYSTEM.md',
  agentAppendSystemFile: 'config/agent/APPEND_SYSTEM.md',
  agentSubagentsDirectory: 'config/agent/subagents',
  workspacesConfigDirectory: 'config/workspaces',

  // credentials
  credentialsDirectory: 'credentials',
  authFile: 'credentials/auth.json',

  // state
  stateDirectory: 'state',
  projectsFile: 'state/projects.json',
  goalsFile: 'state/goals.json',
  agentPermissionsFile: 'state/agent-permissions.json',
  resourcesFile: 'state/resources.json',
  pluginsFile: 'state/plugins.json',
  requestsFile: 'state/requests.jsonl',

  // state/control
  controlDirectory: 'state/control',
  controlSnapshotFile: 'state/control/snapshot.json',
  controlEventsFile: 'state/control/events.jsonl',
  controlOperationsFile: 'state/control/operations.jsonl',

  // state/collaboration
  collaborationDirectory: 'state/collaboration',
  collaborationPlansFile: 'state/collaboration/plans.json',
  collaborationRootsDirectory: 'state/collaboration/roots',

  // state/modules & maintenance
  modulesDirectory: 'state/modules',
  maintenanceDirectory: 'state/maintenance',

  // data
  dataDirectory: 'data',
  sessionsDataDirectory: 'data/sessions',
  plansDataDirectory: 'data/plans',
  attachmentsDirectory: 'data/attachments',

  // resources
  resourcesDirectory: 'resources',
  skillsDirectory: 'resources/skills',
  themesDirectory: 'resources/themes',
  builtinSkillsDirectory: 'resources/builtin/skills',
  snapshotsDirectory: 'resources/snapshots',

  // plugins
  pluginsDirectory: 'plugins',
  pluginPackagesDirectory: 'plugins/packages',
  pluginDataDirectory: 'plugins/data',

  // workspaces
  workspacesDirectory: 'workspaces',
  standaloneWorkspacesDirectory: 'workspaces/standalone',
  worktreesDirectory: 'workspaces/worktrees',

  // cache
  cacheDirectory: 'cache',
  sessionsCacheFile: 'cache/sessions.json',
  remoteServicesCacheFile: 'cache/remote-services.json',

  // logs
  logsDirectory: 'logs',
  mcpLogFile: 'logs/mcp.log',

  // backups
  backupsDirectory: 'backups',
  layoutBackupsDirectory: 'backups/layout',
  legacyBackupsDirectory: 'backups/legacy',
} as const

export type StorageLayoutRelativePaths = typeof storageLayoutRelativePaths
