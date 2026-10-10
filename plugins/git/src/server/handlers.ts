import type { GitFileChange } from '@pi-meme/contracts/desktop'
import { text } from '@pi-meme/contracts/ipc'
import { getGitDiff, getGitSnapshot } from './git-service'

export type GitHandlerContext = {
  getCwd: () => string
}

export function createGitHandlers({ getCwd }: GitHandlerContext) {
  return {
    'git:snapshot': () => getGitSnapshot(getCwd()),
    'git:diff': (filePath: unknown, kind: unknown) => {
      text(filePath)
      if (kind !== 'staged' && kind !== 'unstaged' && kind !== 'untracked') throw new Error('Git 变更类型无效')
      return getGitDiff(getCwd(), filePath, kind as GitFileChange['kind'])
    },
  }
}
