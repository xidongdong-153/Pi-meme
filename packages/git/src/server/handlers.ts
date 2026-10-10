import type { GitFileChange, GitWorktreeResult, SessionSelectionResult } from '@pi-meme/contracts/desktop'
import { text } from '@pi-meme/contracts/ipc'
import { getGitDiff, getGitSnapshot } from './git-service'

export type GitHandlerContext = {
  getCwd: () => string
  environment?: (sessionKey: string) => Promise<import('@pi-meme/contracts/desktop').GitEnvironment>
  switchBranch?: (sessionKey: string, branch: string, baseRef?: string) => Promise<SessionSelectionResult>
  createWorktree?: (sessionKey: string, baseRef: string) => Promise<GitWorktreeResult>
}

export function createGitHandlers({ getCwd, environment, switchBranch, createWorktree }: GitHandlerContext) {
  return {
    'git:environment': (key: unknown) => {
      text(key)
      if (!environment) throw new Error('此 Host 不支持 Git 工作环境操作')
      return environment(key)
    },
    'git:switch-branch': (key: unknown, branch: unknown) => {
      text(key)
      text(branch)
      if (!switchBranch) throw new Error('此 Host 不支持切换分支')
      return switchBranch(key, branch)
    },
    'git:create-branch': (key: unknown, branch: unknown, baseRef: unknown) => {
      text(key)
      text(branch)
      text(baseRef)
      if (!switchBranch) throw new Error('此 Host 不支持创建分支')
      return switchBranch(key, branch, baseRef)
    },
    'git:create-worktree': (key: unknown, baseRef: unknown) => {
      text(key)
      text(baseRef)
      if (!createWorktree) throw new Error('此 Host 不支持创建 Worktree')
      return createWorktree(key, baseRef)
    },
    'git:snapshot': () => getGitSnapshot(getCwd()),
    'git:diff': (filePath: unknown, kind: unknown) => {
      text(filePath)
      if (kind !== 'staged' && kind !== 'unstaged' && kind !== 'untracked') throw new Error('Git 变更类型无效')
      return getGitDiff(getCwd(), filePath, kind as GitFileChange['kind'])
    },
  }
}
