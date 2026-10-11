import * as React from 'react'
import { Check, Copy } from 'lucide-react'
import { Button } from '@pi-meme/ui/components/ui/button'
import { cn } from '@pi-meme/ui/lib/utils'
import { useHighlighter } from './use-highlighter'

export interface CodeBlockProps extends React.HTMLAttributes<HTMLDivElement> {
  code: string
  language?: string
}

export function CodeBlock({ code, language = 'text', className, ...props }: CodeBlockProps) {
  const [copied, setCopied] = React.useState(false)
  const highlighter = useHighlighter()
  const [html, setHtml] = React.useState<string>('')

  React.useEffect(() => {
    if (!highlighter) return
    try {
      const result = highlighter.codeToHtml(code, {
        lang: language,
        theme: 'github-dark-default',
      })
      setHtml(result)
    } catch {
      // 语言不支持时回退到纯文本
      setHtml('')
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
      className={cn('pi-code-block group relative my-3 overflow-hidden rounded-lg font-mono text-sm', className)}
      {...props}
    >
      <div className="pi-code-block-header flex h-8 items-center justify-between px-3 select-none">
        <span className="font-sans text-sm font-medium tracking-wider uppercase">{language}</span>
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
