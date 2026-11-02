export type TurnChangeFile = {
  path: string
  insertions: number
  deletions: number
  patch: string
  status?: string
  canOpen?: boolean
  absolutePath?: string
}

/** 以原生用户消息 entry ID 标识一轮；内容快照只保存在 Host。 */
export type TurnChanges = {
  entryId: string
  revision: string
  files: TurnChangeFile[]
  insertions: number
  deletions: number
  undone: boolean
  undoUnavailable?: string
}

/** 列表只传统计；展开文件时按需读取 patch。 */
export type TurnChangeSummary = Omit<TurnChanges, 'files'> & { files: Omit<TurnChangeFile, 'patch'>[] }
