/** 仅描述有无可查看变更，不包含文件列表、正文或 patch。 */
export type GitWorkspaceAvailability =
  | { status: 'ready'; root?: string; hasStaged: boolean; hasUnstaged: boolean; hasUntracked: boolean }
  | { status: 'error' | 'unsupported'; error?: string }

export type GitTurnAvailability =
  { status: 'ready'; hasChanges: boolean; entryId?: string } | { status: 'error' | 'unsupported'; error?: string }

export type GitAvailability = {
  sessionId: string
  revision: string
  branchRevision?: string
  workspace: GitWorkspaceAvailability
  turns: GitTurnAvailability
  suggestedOpen?: { scope: 'unstaged' | 'staged' | 'turn'; entryId?: string }
}
