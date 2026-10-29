export type DiffLineType = 'add' | 'del' | 'context' | 'meta'

export interface DiffLine {
  type: DiffLineType
  oldLineNumber?: number
  newLineNumber?: number
  content: string
}

export interface DiffHunk {
  id: string
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  heading?: string
  lines: DiffLine[]
}

export interface DiffParseResult {
  isNotice: boolean
  noticeMessage?: string
  isUntrackedText: boolean
  isNew: boolean
  isDeleted: boolean
  isRenamed: boolean
  isBinary: boolean
  additions: number
  deletions: number
  hunks: DiffHunk[]
  rawLines?: string[]
}

export function parseGitDiff(raw: string, isUntracked = false): DiffParseResult {
  const trimmed = raw.trim()
  if (!trimmed) {
    return {
      isNotice: true,
      noticeMessage: '无文件内容或差异',
      isUntrackedText: false,
      isNew: false,
      isDeleted: false,
      isRenamed: false,
      isBinary: false,
      additions: 0,
      deletions: 0,
      hunks: [],
    }
  }

  if (trimmed.startsWith('读取变更失败：')) {
    return {
      isNotice: true,
      noticeMessage: trimmed,
      isUntrackedText: false,
      isNew: false,
      isDeleted: false,
      isRenamed: false,
      isBinary: false,
      additions: 0,
      deletions: 0,
      hunks: [],
    }
  }

  if (trimmed === '二进制文件，不提供文本预览。' || trimmed.includes('Binary files')) {
    return {
      isNotice: true,
      noticeMessage: '二进制文件，不提供文本预览',
      isUntrackedText: false,
      isNew: false,
      isDeleted: false,
      isRenamed: false,
      isBinary: true,
      additions: 0,
      deletions: 0,
      hunks: [],
    }
  }

  if (trimmed.startsWith('文件超过') || trimmed.startsWith('不支持预览')) {
    return {
      isNotice: true,
      noticeMessage: trimmed,
      isUntrackedText: false,
      isNew: false,
      isDeleted: false,
      isRenamed: false,
      isBinary: false,
      additions: 0,
      deletions: 0,
      hunks: [],
    }
  }

  const lines = raw.split('\n')
  const hasGitHeader = lines.some((l) => l.startsWith('diff --git ') || l.startsWith('@@ '))

  if (isUntracked && !hasGitHeader) {
    return {
      isNotice: false,
      isUntrackedText: true,
      isNew: true,
      isDeleted: false,
      isRenamed: false,
      isBinary: false,
      additions: lines.length,
      deletions: 0,
      hunks: [],
      rawLines: lines,
    }
  }

  let isNew = false
  let isDeleted = false
  let isRenamed = false
  let isBinary = false
  let additions = 0
  let deletions = 0
  const hunks: DiffHunk[] = []

  let currentHunk: DiffHunk | null = null
  let curOld = 0
  let curNew = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (!currentHunk) {
      if (line.startsWith('new file mode') || line.startsWith('--- /dev/null')) {
        isNew = true
      } else if (line.startsWith('deleted file mode') || line.startsWith('+++ /dev/null')) {
        isDeleted = true
      } else if (line.startsWith('rename from ') || line.startsWith('similarity index')) {
        isRenamed = true
      } else if (line.includes('Binary files ') || line.startsWith('GIT binary patch')) {
        isBinary = true
      }
    }

    if (line.startsWith('@@ ')) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: (.+))?$/.exec(line)
      if (match) {
        const oldStart = Number.parseInt(match[1], 10)
        const oldCount = match[2] !== undefined ? Number.parseInt(match[2], 10) : 1
        const newStart = Number.parseInt(match[3], 10)
        const newCount = match[4] !== undefined ? Number.parseInt(match[4], 10) : 1
        const heading = match[5]?.trim()

        curOld = oldStart
        curNew = newStart

        currentHunk = {
          id: `hunk-${hunks.length}-${oldStart}-${newStart}`,
          oldStart,
          oldCount,
          newStart,
          newCount,
          heading: heading || undefined,
          lines: [],
        }
        hunks.push(currentHunk)
        continue
      }
    }

    if (!currentHunk) {
      continue
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      additions++
      currentHunk.lines.push({
        type: 'add',
        newLineNumber: curNew++,
        content: line.slice(1),
      })
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      deletions++
      currentHunk.lines.push({
        type: 'del',
        oldLineNumber: curOld++,
        content: line.slice(1),
      })
    } else if (line.startsWith(' ')) {
      currentHunk.lines.push({
        type: 'context',
        oldLineNumber: curOld++,
        newLineNumber: curNew++,
        content: line.slice(1),
      })
    } else if (line.startsWith('\\')) {
      currentHunk.lines.push({
        type: 'meta',
        content: line.slice(1).trim() || '文件末尾无换行符',
      })
    }
  }

  if (isBinary) {
    return {
      isNotice: true,
      noticeMessage: '二进制文件，不提供文本预览',
      isUntrackedText: false,
      isNew,
      isDeleted,
      isRenamed,
      isBinary: true,
      additions: 0,
      deletions: 0,
      hunks: [],
    }
  }

  if (hunks.length === 0) {
    return {
      isNotice: true,
      noticeMessage: isNew ? '新建空文件' : isDeleted ? '已删除空文件' : '无文件内容或差异',
      isUntrackedText: false,
      isNew,
      isDeleted,
      isRenamed,
      isBinary: false,
      additions,
      deletions,
      hunks: [],
    }
  }

  return {
    isNotice: false,
    isUntrackedText: false,
    isNew,
    isDeleted,
    isRenamed,
    isBinary: false,
    additions,
    deletions,
    hunks,
  }
}
