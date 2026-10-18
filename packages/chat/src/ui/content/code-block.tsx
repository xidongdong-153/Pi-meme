import * as React from 'react'
import { Check, Copy } from 'lucide-react'
import { Button } from '@pi-meme/ui/components/ui/button'
import { cn } from '@pi-meme/ui/lib/utils'
import { normalizeCodeLanguage, useHighlighter } from './use-highlighter'

export interface CodeBlockProps extends React.HTMLAttributes<HTMLDivElement> {
  code: string
  language?: string
}

export function CodeBlock({ code, language = 'text', className, ...props }: CodeBlockProps) {
  const [copied, setCopied] = React.useState(false)
  const highlighter = useHighlighter()
  const html = React.useMemo(() => {
    if (!highlighter) return ''
    try {
      return highlighter.codeToHtml(code, {
        lang: normalizeCodeLanguage(language),
        themes: { light: 'github-light-default', dark: 'github-dark-default' },
        defaultColor: 'light-dark()',
      })
    } catch {
      // 未标记或不支持的语言保留原文。
      return ''
    }
  }, [highlighter, code, language])

  const handleCopy = React.useCallback(async () => {
    if (!code) return
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(setCopied, 2000, false)
    } catch {
      // 剪贴板写入异常时静默忽略
    }
  }, [code])

  return (
    <div
      className={cn(
        'pi-code-block group relative my-3 min-w-0 max-w-full overflow-hidden rounded-lg font-mono text-sm',
        className,
      )}
      {...props}
    >
      <div className="pi-code-block-header flex h-8 items-center justify-between px-3 select-none">
        <span className="truncate font-sans text-xs font-medium tracking-wide">
          {language === 'text' ? '纯文本' : language}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-6 opacity-60 hover:opacity-100 transition-opacity"
          onClick={handleCopy}
          aria-label={copied ? '已复制' : '复制代码'}
        >
          {copied ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />}
        </Button>
      </div>
      {html ? (
        <div
          className="pi-code-block-content overflow-x-auto px-4 py-3 text-sm leading-[1.6] select-text"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="pi-code-block-content overflow-x-auto px-4 py-3 text-sm leading-[1.6] text-foreground select-text font-mono">
          <code>{code}</code>
        </pre>
      )}
    </div>
  )
}
