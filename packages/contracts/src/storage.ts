export type HostStorageInfo = { hostId: string; dataRoot: string }
export type StorageProgress = {
  stage: 'scanning' | 'copying' | 'verifying' | 'relocating' | 'cleaning' | 'complete'
  completedBytes: number
  totalBytes: number
}
export type DesktopStorageInfo = HostStorageInfo & {
  source: 'default' | 'custom' | 'environment'
  canMaintain: boolean
  maintenanceDisabledReason?: string
  cacheBytes: number | null
  cacheError?: string
  backupPaths: string[]
  lastError?: string
}
export type StorageTarget = { selectionId: string; path: string; bytes: number; availableBytes: number }
export interface DesktopStorageAdapter {
  getInfo: (expectedHostId: string) => Promise<DesktopStorageInfo>
  chooseTarget: (expectedHostId: string) => Promise<StorageTarget | null>
  migrate: (input: { expectedHostId: string; selectionId: string }) => Promise<void>
  clearCache: (expectedHostId: string) => Promise<void>
  openDirectory: (input: { expectedHostId: string; path: string }) => Promise<void>
}
