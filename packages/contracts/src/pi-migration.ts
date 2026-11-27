export type PiMigrationCategory =
  'instruction' | 'skill' | 'prompt' | 'mcp' | 'model' | 'setting' | 'theme' | 'shortcut' | 'credential'

export type PiMigrationItem = {
  id: string
  category: PiMigrationCategory
  name: string
  source: string
  status: 'new' | 'conflict' | 'same' | 'blocked'
  before?: string
  after?: string
  note?: string
  requires?: string
}

export type PiMigrationScan = {
  source: string
  revision: string
  items: PiMigrationItem[]
}

export type PiMigrationApply = {
  revision: string
  itemIds: string[]
  credentialIds: string[]
}

export type PiMigrationResult = {
  items: Array<
    Pick<PiMigrationItem, 'id' | 'category' | 'name'> & {
      status: 'imported' | 'skipped' | 'failed'
      message: string
    }
  >
  backupDirectory?: string
  refreshError?: string
}

export type DesktopPiMigration = {
  scan: (hostId: string) => Promise<PiMigrationScan>
  apply: (hostId: string, input: PiMigrationApply) => Promise<PiMigrationResult>
}
