import { Children, isValidElement, memo, useEffect, useMemo, useState } from 'react'
import { Check, Copy, TriangleAlert } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { normalizeCodeLanguage, useHighlighter } from '@pi-meme/ui/lib/use-highlighter'
import { Tooltip, TooltipContent, TooltipTrigger } from './primitives'

export function CopyButton({ text, label = '复制消息' }: { text: string; label?: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (status === 'idle') return
    const timer = setTimeout(setStatus, 2200, 'idle')
    return () => clearTimeout(timer)
  }, [status])
  const description = status === 'copied' ? '已复制' : status === 'failed' ? '复制失败，请重试' : label
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="chat-copy-button"
            aria-label={description}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(text)
                setStatus('copied')
              } catch {
                setStatus('failed')
              }
            }}
          >
            {status === 'copied' ? (
              <Check size={14} />
            ) : status === 'failed' ? (
              <TriangleAlert size={14} />
            ) : (
              <Copy size={14} />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent>{description}</TooltipContent>
      </Tooltip>
      <span className="sr-only" role="status">
        {status !== 'idle' ? description : ''}
      </span>
    </>
  )
}

function MessageCode({ code, language }: { code: string; language: string }) {
  const highlighter = useHighlighter()
  const html = useMemo(() => {
    if (!highlighter || code.length > 32000) return ''
    try {
      return highlighter.codeToHtml(code, {
        lang: normalizeCodeLanguage(language || 'text'),
        themes: { light: 'github-light-default', dark: 'github-dark-default' },
        defaultColor: 'light-dark()',
      })
    } catch {
      return ''
    }
  }, [code, language, highlighter])
  return (
    <div className="chat-code">
      <div className="chat-code-heading">
        <span>{language || '代码'}</span>
        <CopyButton text={code} label="复制代码" />
      </div>
      {html ? (
        <div
          className="chat-code-content"
          tabIndex={0}
          role="region"
          aria-label="代码"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre tabIndex={0} aria-label="代码">
          <code>{code}</code>
        </pre>
      )}
    </div>
  )
}

const markdownComponents: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
  pre: ({ children }) => {
    const child = Children.toArray(children)[0]
    if (!isValidElement<{ className?: string; children?: string }>(child)) return <pre>{children}</pre>
    return (
      <MessageCode
        code={child.props.children ?? ''}
        language={(child.props.className ?? '').replace(/^language-/, '')}
      />
    )
  },
  table: ({ children }) => (
    <div className="chat-table" tabIndex={0} role="region" aria-label="表格">
      <table>{children}</table>
    </div>
  ),
}
const markdownPlugins = [remarkGfm]

export const MessageContent = memo(({ text }: { text: string }) => {
  return (
    <div className="markdown pi-content">
      <ReactMarkdown remarkPlugins={markdownPlugins} components={markdownComponents}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
