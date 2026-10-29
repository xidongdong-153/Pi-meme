import { useMemo, useState, type CSSProperties } from 'react'
import { ChevronsUpDown } from 'lucide-react'
import { useHighlighter } from '@pi-meme/ui/lib/use-highlighter'
import { cn } from '@pi-meme/ui/lib/utils'
import { parseGitDiff, type DiffLine } from './git-diff-parser'

export { parseGitDiff } from './git-diff-parser'

type Row = { left?: DiffLine; right?: DiffLine; unified: DiffLine[] }
type Segment = { id: string; rows: Row[]; gap: boolean; unavailable?: boolean }
const linesOf = (text: string) => (text ? text.replace(/\n$/, '').split('\n') : [])

export function pairDiffLines(lines: DiffLine[]): Row[] {
  const rows: Row[] = []
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!
    if (line.type === 'del' || line.type === 'add') {
      const removed: DiffLine[] = []
      const added: DiffLine[] = []
      while (lines[i]?.type === 'del') removed.push(lines[i++]!)
      while (lines[i]?.type === 'add') added.push(lines[i++]!)
      for (let j = 0; j < Math.max(removed.length, added.length); j++)
        rows.push({
          left: removed[j],
          right: added[j],
          unified: [removed[j], added[j]].filter((item): item is DiffLine => !!item),
        })
    } else {
      rows.push({ left: line, right: line, unified: [line] })
      i++
    }
  }
  return rows
}

export function GitDiffViewer({
  diff,
  isUntracked = false,
  path = '',
  before,
  after,
  notice,
  split = false,
  wrap = true,
}: {
  diff: string
  isUntracked?: boolean
  path?: string
  before?: string
  after?: string
  notice?: string
  split?: boolean
  wrap?: boolean
}) {
  const parsed = useMemo(() => parseGitDiff(diff, isUntracked), [diff, isUntracked])
  const [expanded, setExpanded] = useState<Record<string, number>>({})
  const [full, setFull] = useState(false)
  const highlighter = useHighlighter()
  const segments = useMemo(() => {
    const result: Segment[] = []
    const oldLines = before === undefined ? undefined : linesOf(before)
    const newLines = after === undefined ? undefined : linesOf(after)
    let oldCursor = 1
    let newCursor = 1
    const gap = (oldEnd: number, newEnd: number) => {
      const count = Math.min(oldEnd - oldCursor, newEnd - newCursor)
      if (count <= 0) return
      const rows = Array.from({ length: count }, (_, i) => {
        const line: DiffLine = {
          type: 'context',
          oldLineNumber: oldCursor + i,
          newLineNumber: newCursor + i,
          content: oldLines?.[oldCursor + i - 1] ?? newLines?.[newCursor + i - 1] ?? '',
        }
        return { left: line, right: line, unified: [line] }
      })
      result.push({ id: `gap-${oldCursor}`, rows, gap: true, unavailable: !oldLines || !newLines })
    }
    if (parsed.isUntrackedText)
      return [
        {
          id: 'new',
          gap: false,
          rows: pairDiffLines(
            (parsed.rawLines ?? []).map((content, i) => ({ type: 'add', newLineNumber: i + 1, content })),
          ),
        },
      ]
    for (const hunk of parsed.hunks) {
      gap(Math.max(1, hunk.oldStart), Math.max(1, hunk.newStart))
      result.push({ id: hunk.id, rows: pairDiffLines(hunk.lines), gap: false })
      oldCursor = hunk.oldStart + hunk.oldCount
      newCursor = hunk.newStart + hunk.newCount
    }
    if (oldLines && newLines) gap(oldLines.length + 1, newLines.length + 1)
    return result
  }, [parsed, before, after])
  const tokens = useMemo(() => {
    if (!highlighter) return null
    const extension = path.split('.').pop()?.toLowerCase() ?? ''
    const aliases: Record<string, string> = {
      ts: 'typescript',
      js: 'javascript',
      mjs: 'javascript',
      cjs: 'javascript',
      md: 'markdown',
      yml: 'yaml',
      sh: 'shellscript',
      py: 'python',
      rs: 'rust',
      cs: 'csharp',
    }
    const lang = aliases[extension] ?? extension
    if (!highlighter.getLoadedLanguages().includes(lang)) return null
    try {
      const source = (side: 'before' | 'after') => {
        const content = side === 'before' ? before : after
        if (content !== undefined) return linesOf(content)
        const lines: string[] = []
        for (const hunk of parsed.hunks)
          for (const line of hunk.lines) {
            const number = side === 'before' ? line.oldLineNumber : line.newLineNumber
            if (number) lines[number - 1] = line.content
          }
        return Array.from(lines, (line) => line ?? '')
      }
      return {
        before: highlighter.codeToTokens(source('before').join('\n'), {
          lang,
          themes: { light: 'github-light-default', dark: 'github-dark-default' },
        }).tokens,
        after: highlighter.codeToTokens(source('after').join('\n'), {
          lang,
          themes: { light: 'github-light-default', dark: 'github-dark-default' },
        }).tokens,
      }
    } catch {
      return null
    }
  }, [highlighter, path, before, after, parsed])
  const code = (line: DiffLine) => {
    const side = line.type === 'del' ? 'before' : 'after'
    const number = side === 'before' ? line.oldLineNumber : line.newLineNumber
    const highlighted = number ? tokens?.[side][number - 1] : undefined
    return highlighted?.length
      ? highlighted.map((token, i) => (
          <span
            key={i}
            style={{ color: token.color, '--diff-dark': token.htmlStyle?.['--shiki-dark'] } as CSSProperties}
            className="dark:!text-[var(--diff-dark)]"
          >
            {token.content}
          </span>
        ))
      : line.content || ' '
  }
  const cell = (line: DiffLine | undefined, side?: 'left' | 'right') => (
    <div
      className={cn(
        'flex min-w-0 min-h-6',
        line?.type === 'add' && 'bg-emerald-500/10',
        line?.type === 'del' && 'bg-rose-500/10',
        !line && 'bg-muted/30',
      )}
    >
      {side ? (
        <span className="w-10 shrink-0 select-none pr-2 text-right text-muted-foreground">
          {side === 'left' ? line?.oldLineNumber : line?.newLineNumber}
        </span>
      ) : (
        <>
          <span className="w-9 shrink-0 select-none pr-1 text-right text-muted-foreground">{line?.oldLineNumber}</span>
          <span className="w-9 shrink-0 select-none pr-1 text-right text-muted-foreground">{line?.newLineNumber}</span>
        </>
      )}
      <span
        className={cn(
          'w-4 shrink-0 select-none text-center',
          line?.type === 'add' ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400',
        )}
      >
        {line?.type === 'add' ? '+' : line?.type === 'del' ? '−' : ''}
      </span>
      <code
        className={cn(
          'min-w-0 flex-1 px-2 [tab-size:2]',
          wrap ? 'whitespace-pre-wrap break-words [overflow-wrap:anywhere]' : 'whitespace-pre',
        )}
      >
        {line ? code(line) : ' '}
      </code>
    </div>
  )
  if (notice) return <p className="px-4 py-4 text-xs text-muted-foreground">{notice}</p>
  if (parsed.isNotice && !segments.some((s) => s.rows.length))
    return <p className="px-4 py-4 text-xs text-muted-foreground">{parsed.noticeMessage}</p>
  return (
    <div aria-label="Diff 变更详情" className="border-t border-border/60 bg-background text-xs">
      <div className="flex items-center justify-between gap-2 border-b border-border/50 bg-muted/30 px-3 py-1.5 text-[11px] text-muted-foreground">
        <span>
          {split ? '修改前 / 修改后' : '差异'}
          {before === undefined || after === undefined ? ' · 未保存完整上下文' : ''}
        </span>
        <button
          type="button"
          className="rounded px-1.5 py-0.5 hover:bg-secondary focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
          disabled={before === undefined || after === undefined}
          onClick={() => setFull((value) => !value)}
        >
          {full ? '折叠未修改代码' : '展开完整文件'}
        </button>
      </div>
      <div className="overflow-x-auto font-mono text-[11px] leading-6 select-text">
        <div className={cn(!wrap && 'min-w-full w-max')}>
          {segments.map((segment) => {
            const shown = !segment.gap || full ? segment.rows.length : (expanded[segment.id] ?? 0)
            const visible = segment.unavailable ? [] : segment.rows.slice(0, shown)
            return (
              <div key={segment.id}>
                {visible.map((row, i) =>
                  split ? (
                    <div key={i} className="grid grid-cols-2 divide-x divide-border/60">
                      {cell(row.left, 'left')}
                      {cell(row.right, 'right')}
                    </div>
                  ) : (
                    row.unified.map((line, j) => <div key={`${i}:${j}`}>{cell(line)}</div>)
                  ),
                )}
                {segment.gap && (segment.unavailable || shown < segment.rows.length) && (
                  <button
                    type="button"
                    disabled={segment.unavailable}
                    onClick={() =>
                      setExpanded((value) => ({ ...value, [segment.id]: Math.min(segment.rows.length, shown + 20) }))
                    }
                    className="flex w-full items-center gap-2 border-y border-border/50 bg-muted/50 px-3 py-1.5 text-left font-sans text-xs text-muted-foreground hover:bg-secondary disabled:cursor-default"
                  >
                    <ChevronsUpDown className="size-3.5" />
                    {segment.rows.length - (segment.unavailable ? 0 : shown)} 行未修改
                    {segment.unavailable ? ' · 历史上下文不可用' : ' · 展开 20 行'}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
