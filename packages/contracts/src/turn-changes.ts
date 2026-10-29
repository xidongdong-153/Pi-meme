export type TurnChangeFile = {
  path: string
  insertions: number
  deletions: number
  patch: string
}

/** 以原生用户消息 entry ID 标识一轮；内容快照只保存在 Host。 */
export type TurnChanges = {
  entryId: string
  files: TurnChangeFile[]
  insertions: number
  deletions: number
  undone: boolean
  undoUnavailable?: string
}
