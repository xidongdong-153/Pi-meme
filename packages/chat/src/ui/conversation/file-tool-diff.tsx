import { useMemo, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button } from '@pi-meme/ui/components/ui/button'
import { cn } from '@pi-meme/ui/lib/utils'
import { useHighlighter } from '@pi-meme/ui/lib/use-highlighter'
import { ToolDiff } from './tool-diff'

type Line = { kind: 'add' | 'del' | 'context' | 'hunk'; text: string; number?: number }

function parseLines(patch: string): Line[] {
  const lines: Line[] = []
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  for (const text of patch.split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text)
    if (header) {
      oldLine = Number(header[1])
      newLine = Number(header[2])
      if (inHunk) lines.push({ kind: 'hunk', text })
      inHunk = true
    } else if (inHunk && text.startsWith('+')) {
      lines.push({ kind: 'add', text: text.slice(1), number: newLine++ })
    } else if (inHunk && text.startsWith('-')) {
      lines.push({ kind: 'del', text: text.slice(1), number: oldLine++ })
    } else if (inHunk && text.startsWith(' ')) {
      lines.push({ kind: 'context', text: text.slice(1), number: newLine++ })
      oldLine++
    }
  }
  return lines
}

export function FileToolDiff({ patch, path }: { patch: string; path?: string }) {
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)
  const highlighter = useHighlighter()
  const lines = useMemo(() => parseLines(patch), [patch])
  const tokens = useMemo(() => {
    if (!highlighter || !lines.length) return
    const extension = path?.split('.').pop()?.toLowerCase() ?? 'text'
    const language = highlighter.getLoadedLanguages().includes(extension) ? extension : 'text'
    try {
      return highlighter.codeToTokens(lines.map((line) => line.text).join('\n'), {
        lang: language,
        themes: { light: 'github-light-default', dark: 'github-dark-default' },
        defaultColor: 'light-dark()',
      }).tokens
    } catch {
      // 不支持的代码内容保留原文。
    }
  }, [highlighter, lines, path])
  const insertions = lines.filter((line) => line.kind === 'add').length
  const deletions = lines.filter((line) => line.kind === 'del').length
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(patch)
      setCopied(true)
      setCopyError(false)
      setTimeout(setCopied, 2000, false)
    } catch {
      setCopyError(true)
    }
  }
  return (
    <section
      aria-label={`文件差异：${path ?? '文件'}`}
      className="my-2 min-w-0 overflow-hidden rounded-xl border border-border/60 bg-card/50 select-text"
    >
      <div className="flex min-w-0 items-center gap-2 border-b border-border/60 bg-secondary/50 px-3 py-1.5 font-mono text-xs">
        <span className="min-w-0 truncate text-muted-foreground" title={path}>
          {path?.split(/[\\/]/).pop() ?? '文件变更'}
        </span>
        {lines.length > 0 && (
          <span className="inline-flex shrink-0 gap-1.5 tabular-nums">
            <span className="text-emerald-600 dark:text-emerald-400">+{insertions}</span>
            <span className="text-rose-600 dark:text-rose-400">−{deletions}</span>
          </span>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto shrink-0"
          aria-label={copied ? '已复制 Diff' : '复制 Diff'}
          onClick={() => void copy()}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </Button>
      </div>
      {copyError && (
        <p role="alert" className="px-3 py-1 text-xs text-destructive">
          复制失败，请重试。
        </p>
      )}
      <div
        tabIndex={0}
        role="region"
        aria-label="Diff 代码"
        className="max-h-64 overflow-auto overscroll-contain focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {lines.length ? (
          <pre className="pi-code-text m-0 w-max min-w-full py-1 font-mono text-xs leading-6">
            {lines.map((line, index) => (
              <div
                key={index}
                className={cn(
                  'flex min-w-full',
                  line.kind === 'add' && 'bg-emerald-500/15',
                  line.kind === 'del' && 'bg-rose-500/15',
                  line.kind === 'hunk' && 'bg-secondary/50 text-muted-foreground',
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'sticky left-0 w-14 shrink-0 border-r border-border/40 bg-card px-2 text-right tabular-nums select-none',
                    line.kind === 'add'
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : line.kind === 'del'
                        ? 'text-rose-600 dark:text-rose-400'
                        : 'text-muted-foreground',
                  )}
                >
                  {line.number ?? '…'}
                </span>
                <span aria-hidden="true" className="w-5 shrink-0 text-center text-muted-foreground select-none">
                  {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ''}
                </span>
                <code className="pr-4 whitespace-pre">
                  {tokens?.[index]?.map((token, tokenIndex) => (
                    <span key={tokenIndex} style={{ color: token.htmlStyle?.color ?? token.color }}>
                      {token.content}
                    </span>
                  )) ??
                    (line.text || ' ')}
                </code>
              </div>
            ))}
          </pre>
        ) : (
          <div className="p-3">
            <ToolDiff diff={patch} />
          </div>
        )}
      </div>
    </section>
  )
}
