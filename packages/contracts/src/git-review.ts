import type { GitBranch } from './desktop'

export type GitReviewQuery = {
  scope: 'uncommitted' | 'unstaged' | 'staged' | 'commit' | 'branch'
  ref?: string
}

export type GitReviewFile = {
  path: string
  oldPath?: string
  status: string
  insertions: number | null
  deletions: number | null
  canOpen: boolean
}

export type GitReviewSnapshot = {
  cwd: string
  root: string
  branch?: string
  error?: 'not-repository' | 'unavailable'
  files: GitReviewFile[]
  insertions: number
  deletions: number
}

export type GitReviewFileContent = {
  patch: string
  before?: string
  after?: string
  notice?: string
}

export type GitReviewOptions = {
  error?: 'not-repository' | 'unavailable'
  branches: GitBranch[]
  upstream?: string
  commits: Array<{ sha: string; subject: string }>
  hasMore: boolean
}
