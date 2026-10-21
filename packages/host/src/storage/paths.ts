import path from 'node:path'
import {
  STORAGE_LAYOUT_FORMAT,
  STORAGE_LAYOUT_VERSION,
  type StorageLayoutManifest,
  storageLayoutRelativePaths,
  type StorageLayoutRelativePaths,
} from '@pi-meme/contracts/storage-paths'

export { STORAGE_LAYOUT_FORMAT, STORAGE_LAYOUT_VERSION, type StorageLayoutManifest, storageLayoutRelativePaths }

export type HostStorageFixedPaths = {
  readonly [K in keyof StorageLayoutRelativePaths]: string
}

export type HostStorageDynamicPaths = {
  readonly root: string
  readonly workspaceConfigDirectory: (cwdHash: string) => string
  readonly workspaceMcpOverridesFile: (cwdHash: string) => string
  readonly workspaceResourcesFile: (cwdHash: string) => string
  readonly collaborationRootFile: (rootAgentId: string) => string
  readonly moduleDirectory: (encodedPluginId: string) => string
  readonly sessionDataDirectory: (cwdHash: string) => string
  readonly sessionPlansDirectory: (sessionId: string) => string
  readonly planFile: (sessionId: string, planId: string) => string
  readonly snapshotDirectory: (revision: string) => string
  readonly pluginPrivateDirectory: (encodedPluginId: string) => string
  readonly standaloneWorkspaceDirectory: (id: string) => string
  readonly worktreeDirectory: (id: string) => string
  readonly layoutBackupDirectory: (jobId: string) => string
  readonly legacyBackupDirectory: (jobId: string) => string
  readonly resolve: (relativePath: string) => string
}

export type HostStoragePaths = HostStorageFixedPaths & HostStorageDynamicPaths

export function createHostStoragePaths(root: string): HostStoragePaths {
  const resolvedRoot = path.resolve(root)
  const join = (...segments: string[]) => path.join(resolvedRoot, ...segments)

  const fixed = Object.fromEntries(
    Object.entries(storageLayoutRelativePaths).map(([key, relativePath]) => [key, join(relativePath)]),
  ) as HostStorageFixedPaths

  const dynamic: HostStorageDynamicPaths = {
    root: resolvedRoot,
    workspaceConfigDirectory: (cwdHash: string) => join(storageLayoutRelativePaths.workspacesConfigDirectory, cwdHash),
    workspaceMcpOverridesFile: (cwdHash: string) =>
      join(storageLayoutRelativePaths.workspacesConfigDirectory, cwdHash, 'mcp-overrides.json'),
    workspaceResourcesFile: (cwdHash: string) =>
      join(storageLayoutRelativePaths.workspacesConfigDirectory, cwdHash, 'resources.json'),
    collaborationRootFile: (rootAgentId: string) =>
      join(storageLayoutRelativePaths.collaborationRootsDirectory, `${rootAgentId}.json`),
    moduleDirectory: (encodedPluginId: string) => join(storageLayoutRelativePaths.modulesDirectory, encodedPluginId),
    sessionDataDirectory: (cwdHash: string) => join(storageLayoutRelativePaths.sessionsDataDirectory, cwdHash),
    sessionPlansDirectory: (sessionId: string) => join(storageLayoutRelativePaths.plansDataDirectory, sessionId),
    planFile: (sessionId: string, planId: string) =>
      join(storageLayoutRelativePaths.plansDataDirectory, sessionId, `${planId}.md`),
    snapshotDirectory: (revision: string) => join(storageLayoutRelativePaths.snapshotsDirectory, revision),
    pluginPrivateDirectory: (encodedPluginId: string) =>
      join(storageLayoutRelativePaths.pluginDataDirectory, encodedPluginId),
    standaloneWorkspaceDirectory: (id: string) => join(storageLayoutRelativePaths.standaloneWorkspacesDirectory, id),
    worktreeDirectory: (id: string) => join(storageLayoutRelativePaths.worktreesDirectory, id),
    layoutBackupDirectory: (jobId: string) => join(storageLayoutRelativePaths.layoutBackupsDirectory, jobId),
    legacyBackupDirectory: (jobId: string) => join(storageLayoutRelativePaths.legacyBackupsDirectory, jobId),
    resolve: (relativePath: string) => path.resolve(resolvedRoot, relativePath),
  }

  return Object.assign(fixed, dynamic)
}
