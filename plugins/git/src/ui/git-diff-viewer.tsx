import * as React from 'react'
import { AlertCircle, Check, Copy, FileCode, FilePlus, FileX, Info } from 'lucide-react'
import { Badge } from '@pi-meme/ui/components/ui/badge'
import { Button } from '@pi-meme/ui/components/ui/button'
import { cn } from '@pi-meme/ui/lib/utils'

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

export function GitDiffViewer({ diff, isUntracked = false }: { diff: string; isUntracked?: boolean }) {
  const [copied, setCopied] = React.useState(false)

  const parsed = React.useMemo(() => parseGitDiff(diff, isUntracked), [diff, isUntracked])

  const handleCopy = React.useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation()
      try {
        await navigator.clipboard.writeText(diff)
        setCopied(true)
        window.setTimeout(setCopied, 1500, false)
      } catch {
        // 剪贴板不可用时静默忽略
      }
    },
    [diff],
  )

  if (parsed.isNotice) {
    return (
      <div className="mx-2 my-1.5 flex items-center gap-2 rounded border border-border/50 bg-secondary/20 px-3 py-2 text-[0.6875rem] text-muted-foreground">
        {parsed.isBinary ? (
          <FileCode className="size-3.5 shrink-0 text-muted-foreground" />
        ) : parsed.noticeMessage?.includes('失败') ? (
          <AlertCircle className="size-3.5 shrink-0 text-rose-500" />
        ) : (
          <Info className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="flex-1 truncate">{parsed.noticeMessage}</span>
      </div>
    )
  }

  return (
    <div className="mx-2 my-1 overflow-hidden rounded-md border border-border/60 bg-background/90 shadow-2xs">
      {/* 顶部微型信息栏 */}
      <div className="flex items-center justify-between border-b border-border/50 bg-muted/40 px-2.5 py-1 text-[0.625rem]">
        <div className="flex items-center gap-1.5 min-w-0">
          {parsed.isNew && (
            <Badge
              variant="outline"
              className="h-4 gap-0.5 border-emerald-500/30 px-1 text-[0.5625rem] text-emerald-600 dark:text-emerald-400"
            >
              <FilePlus className="size-2.5" />
              <span>新建文件</span>
            </Badge>
          )}
          {parsed.isDeleted && (
            <Badge
              variant="outline"
              className="h-4 gap-0.5 border-rose-500/30 px-1 text-[0.5625rem] text-rose-600 dark:text-rose-400"
            >
              <FileX className="size-2.5" />
              <span>已删除</span>
            </Badge>
          )}
          {parsed.isUntrackedText && !parsed.isNew && (
            <Badge variant="outline" className="h-4 px-1 text-[0.5625rem] text-muted-foreground">
              未跟踪
            </Badge>
          )}
          <span className="shrink-0 font-mono text-emerald-600 dark:text-emerald-400 font-medium">
            +{parsed.additions}
          </span>
          <span className="shrink-0 font-mono text-rose-600 dark:text-rose-400 font-medium">−{parsed.deletions}</span>
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={handleCopy}
          aria-label="复制 Diff 内容"
          title={copied ? '已复制' : '复制 Diff'}
          className="size-5 shrink-0 p-0 text-muted-foreground hover:text-foreground [&_svg]:size-3"
        >
          {copied ? <Check className="size-3 text-emerald-500" /> : <Copy className="size-3" />}
        </Button>
      </div>

      {/* Diff 内容滚动区域 */}
      <div
        className="max-h-[360px] overflow-auto font-mono text-[0.6875rem] leading-[1.35rem] select-text"
        aria-label="Diff 变更详情"
      >
        <div className="min-w-full w-max">
          {parsed.isUntrackedText && parsed.rawLines ? (
            /* 未跟踪文件的完整代码预览 */
            <div className="py-1">
              {parsed.rawLines.map((line, idx) => (
                <div key={idx} className="flex items-stretch min-w-full hover:bg-muted/20 transition-colors">
                  <span className="w-8 shrink-0 select-none pr-1.5 text-right font-mono text-[0.625rem] text-muted-foreground/40">
                    {idx + 1}
                  </span>
                  <span className="w-4 shrink-0 select-none text-center font-mono text-[0.625rem] text-emerald-500/80 font-medium">
                    +
                  </span>
                  <span className="min-w-0 flex-1 whitespace-pre pl-1 pr-4 [tab-size:2] text-foreground/90">
                    {line || ' '}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            /* 标准 Unified Diff Hunks 预览 */
            parsed.hunks.map((hunk) => {
              const showHunkHeader =
                !(parsed.isNew && parsed.hunks.length <= 1) &&
                !(parsed.hunks.length <= 1 && hunk.newStart <= 1 && !hunk.heading)

              return (
                <div key={hunk.id} className="border-b border-border/30 last:border-b-0">
                  {/* Hunk 分隔头：多块改动或深层跳转时展示直观行号与函数上下文 */}
                  {showHunkHeader && (
                    <div className="sticky top-0 z-10 flex items-center justify-between border-y border-border/30 bg-muted/40 px-2 py-0.5 text-[0.625rem] text-muted-foreground backdrop-blur-xs select-none">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="font-mono text-[0.5625rem] text-muted-foreground/70">
                          第 {hunk.newStart} 行起
                        </span>
                        {hunk.heading && (
                          <span
                            className="min-w-0 truncate font-mono text-[0.5625rem] text-foreground/75"
                            title={hunk.heading}
                          >
                            {hunk.heading}
                          </span>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Hunk 内部行 */}
                  <div>
                    {hunk.lines.map((line, lineIdx) => {
                      const isAdd = line.type === 'add'
                      const isDel = line.type === 'del'
                      const isMeta = line.type === 'meta'
                      const isSingleColumn = parsed.isNew || parsed.isDeleted

                      if (isMeta) {
                        return (
                          <div
                            key={lineIdx}
                            className="flex items-stretch min-w-full bg-muted/15 px-2 py-0.5 text-[0.5625rem] italic text-muted-foreground/70"
                          >
                            <span className="select-none">\\ {line.content}</span>
                          </div>
                        )
                      }

                      return (
                        <div
                          key={lineIdx}
                          className={cn(
                            'flex items-stretch min-w-full transition-colors',
                            isAdd && 'bg-emerald-500/10 hover:bg-emerald-500/15 text-emerald-800 dark:text-emerald-200',
                            isDel && 'bg-rose-500/10 hover:bg-rose-500/15 text-rose-800 dark:text-rose-200',
                            !isAdd && !isDel && 'hover:bg-muted/25 text-foreground/85',
                          )}
                        >
                          {/* 行号区：新建/删除文件仅展示单列行号，常规修改展示新旧双列 */}
                          {isSingleColumn ? (
                            <span
                              className={cn(
                                'w-7 shrink-0 select-none pr-1 text-right font-mono text-[0.625rem]',
                                isAdd
                                  ? 'text-emerald-600/70 dark:text-emerald-400/70 font-medium'
                                  : 'text-rose-600/70 dark:text-rose-400/70 font-medium',
                              )}
                            >
                              {(parsed.isNew ? line.newLineNumber : line.oldLineNumber) ?? ''}
                            </span>
                          ) : (
                            <>
                              <span
                                className={cn(
                                  'w-7 shrink-0 select-none pr-1 text-right font-mono text-[0.625rem]',
                                  isDel
                                    ? 'text-rose-600/70 dark:text-rose-400/70 font-medium'
                                    : 'text-muted-foreground/35',
                                )}
                              >
                                {line.oldLineNumber ?? ''}
                              </span>
                              <span
                                className={cn(
                                  'w-7 shrink-0 select-none pr-1 text-right font-mono text-[0.625rem]',
                                  isAdd
                                    ? 'text-emerald-600/70 dark:text-emerald-400/70 font-medium'
                                    : 'text-muted-foreground/35',
                                )}
                              >
                                {line.newLineNumber ?? ''}
                              </span>
                            </>
                          )}

                          {/* 变更标记符号 (+ / - / 空) */}
                          <span
                            className={cn(
                              'w-4 shrink-0 select-none text-center font-mono text-[0.6875rem]',
                              isAdd && 'text-emerald-600 dark:text-emerald-400 font-semibold',
                              isDel && 'text-rose-600 dark:text-rose-400 font-semibold',
                              !isAdd && !isDel && 'text-transparent',
                            )}
                          >
                            {isAdd ? '+' : isDel ? '−' : ' '}
                          </span>

                          {/* 代码文本 */}
                          <span className="min-w-0 flex-1 whitespace-pre pl-0.5 pr-4 [tab-size:2]">
                            {line.content || ' '}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
