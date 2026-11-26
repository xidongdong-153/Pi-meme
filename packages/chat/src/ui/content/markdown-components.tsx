import { validateVisualizationRef } from '@pi-meme/contracts/visualize'
import { VisualizationRenderer } from '@pi-meme/ui/components/visualization-renderer'
import * as React from 'react'
import { Maximize2 } from 'lucide-react'
import type { ExtraProps } from 'react-markdown'
import { Dialog, DialogContent, DialogTitle } from '@pi-meme/ui/components/ui/dialog'
import { cn } from '@pi-meme/ui/lib/utils'
import { CodeBlock } from './code-block'
import { MermaidBlock } from './mermaid-block'
import { isImageLink, MessageImage } from './message-image'
import { MarkdownLink } from './markdown-link'

export const MarkdownHiddenVisualizationsContext = React.createContext<ReadonlySet<string>>(new Set())
export const MarkdownHiddenImagesContext = React.createContext<ReadonlySet<string>>(new Set())

export const MarkdownStreamingContext = React.createContext(false)

function isHiddenImage(path: string, hidden: ReadonlySet<string>) {
  if (hidden.has(path)) return true
  try {
    return hidden.has(decodeURIComponent(path))
  } catch {
    return false
  }
}

function MarkdownImage({ src, alt }: React.ComponentPropsWithoutRef<'img'>) {
  const hidden = React.useContext(MarkdownHiddenImagesContext)
  if (typeof src !== 'string' || !src || isHiddenImage(src, hidden)) return null
  return <MessageImage key={src} src={src} alt={alt} />
}

function MarkdownAnchor({ href, children, node, title }: React.ComponentPropsWithoutRef<'a'> & ExtraProps) {
  const hidden = React.useContext(MarkdownHiddenImagesContext)
  if (node?.children.some((child) => child.type === 'element' && child.tagName === 'img')) return <>{children}</>
  if (href && isImageLink(href) && !isHiddenImage(href, hidden)) {
    const label = React.Children.toArray(children)
      .filter((child) => typeof child === 'string' || typeof child === 'number')
      .join('')
    return <MessageImage key={href} src={href} alt={label === href ? undefined : label} />
  }
  return (
    <MarkdownLink href={href} title={title}>
      {children}
    </MarkdownLink>
  )
}

function MarkdownPre({ children }: React.ComponentPropsWithoutRef<'pre'>) {
  const isStreaming = React.useContext(MarkdownStreamingContext)
  const hiddenVisualizations = React.useContext(MarkdownHiddenVisualizationsContext)
  const child = React.Children.toArray(children)[0]
  if (!React.isValidElement<React.ComponentPropsWithoutRef<'code'>>(child)) return <pre>{children}</pre>
  const language = /(?:^|\s)language-(\S+)/.exec(child.props.className ?? '')?.[1]
  const code = String(child.props.children ?? '').replace(/\n$/, '')
  if (language === 'visualize') {
    try {
      const reference = JSON.parse(code)
      validateVisualizationRef(reference)
      if (hiddenVisualizations.has(`${reference.id}:${reference.revision}`)) return null
      if (!isStreaming) return <VisualizationRenderer reference={reference} />
    } catch {
      if (!isStreaming) return <p>可视化引用无效。</p>
    }
  }
  return language?.toLowerCase() === 'mermaid' ? (
    <MermaidBlock code={code} isStreaming={isStreaming} />
  ) : (
    <CodeBlock code={code} language={language} />
  )
}

/**
 * 解析 GitHub-style alert blockquote。
 * 匹配 "[!NOTE]"、"[!TIP]"、"[!IMPORTANT]"、"[!WARNING]"、"[!CAUTION]"。
 */
function parseAlert(children: React.ReactNode): { type: string; content: React.ReactNode } | null {
  const kids = React.Children.toArray(children)
  if (kids.length === 0) return null
  const firstIndex = kids.findIndex(React.isValidElement)
  const first = kids[firstIndex]
  if (!React.isValidElement(first)) return null

  const pChildren = React.Children.toArray((first.props as { children?: React.ReactNode }).children)
  if (pChildren.length === 0) return null

  const firstText = typeof pChildren[0] === 'string' ? pChildren[0] : null
  if (!firstText) return null

  const alertMatch = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i.exec(firstText)
  if (!alertMatch) return null

  const alertType = alertMatch[1].toLowerCase()
  const remainingText = firstText.slice(alertMatch[0].length)

  // 重构第一个 <p> 的内容，去掉 alert 标记
  const newPChildren = remainingText ? [remainingText, ...pChildren.slice(1)] : pChildren.slice(1)
  const restKids = kids.slice(firstIndex + 1)

  const content = (
    <>
      {newPChildren.length > 0 && <p className="mb-2 last:mb-0 leading-relaxed">{newPChildren}</p>}
      {restKids}
    </>
  )

  return { type: alertType, content }
}

const alertLabels: Record<string, string> = {
  note: 'Note',
  tip: 'Tip',
  important: 'Important',
  warning: 'Warning',
  caution: 'Caution',
}

function MarkdownTable({ children }: React.ComponentPropsWithoutRef<'table'>) {
  const [fullscreen, setFullscreen] = React.useState(false)
  return (
    <div className="group/table relative">
      <button
        type="button"
        aria-label="全屏查看表格"
        onClick={() => setFullscreen(true)}
        className="pi-fullscreen-trigger absolute right-1 top-1 z-10 inline-flex size-7 items-center justify-center rounded-lg bg-background/85 text-muted-foreground opacity-0 shadow-2xs backdrop-blur-xs transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/table:opacity-100"
      >
        <Maximize2 className="size-3.5" />
      </button>
      <div className="pi-table-wrapper">
        <table className="pi-table">{children}</table>
      </div>
      {fullscreen && (
        <Dialog open onOpenChange={setFullscreen}>
          <DialogContent
            aria-describedby={undefined}
            className="flex h-[88dvh] max-h-none w-[calc(100vw-16px)] max-w-5xl flex-col gap-0 overflow-hidden rounded-2xl p-0"
            closeButtonProps={{
              'aria-label': '关闭全屏表格',
              className:
                'right-3 top-2.5 inline-flex size-9 items-center justify-center rounded-xl text-muted-foreground opacity-100 active:bg-secondary active:text-foreground',
            }}
          >
            <div className="flex shrink-0 items-center border-b border-border/60 pl-4 pr-14 py-3">
              <DialogTitle className="text-sm font-medium">表格视图</DialogTitle>
            </div>
            <div className="pi-markdown min-h-0 flex-1 overflow-auto p-4">
              <table className="pi-table">{children}</table>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}

export function useMarkdownComponents() {
  return React.useMemo(
    () => ({
      pre: MarkdownPre,
      code({ className, children, node: _node, ...props }: React.ComponentPropsWithoutRef<'code'> & ExtraProps) {
        return (
          <code className={cn('pi-inline-code', className)} {...props}>
            {children}
          </code>
        )
      },

      table: MarkdownTable,
      thead({ children }: React.ComponentPropsWithoutRef<'thead'>) {
        return <thead className="pi-thead">{children}</thead>
      },
      th({ children, style }: React.ComponentPropsWithoutRef<'th'>) {
        return (
          <th className="pi-th" style={style}>
            {children}
          </th>
        )
      },
      td({ children, style }: React.ComponentPropsWithoutRef<'td'>) {
        return (
          <td className="pi-td" style={style}>
            {children}
          </td>
        )
      },
      tr({ children }: React.ComponentPropsWithoutRef<'tr'>) {
        return <tr className="pi-tr">{children}</tr>
      },

      a: MarkdownAnchor,

      blockquote({ children }: React.ComponentPropsWithoutRef<'blockquote'>) {
        const alert = parseAlert(children)
        if (alert) {
          return (
            <div className={`pi-alert pi-alert-${alert.type}`}>
              <div className="pi-alert-title">{alertLabels[alert.type]}</div>
              <div className="pi-alert-body">{alert.content}</div>
            </div>
          )
        }
        return <blockquote className="pi-blockquote">{children}</blockquote>
      },

      ul({ children, className }: React.ComponentPropsWithoutRef<'ul'>) {
        return <ul className={cn('pi-ul', className)}>{children}</ul>
      },
      ol({ children, start, className }: React.ComponentPropsWithoutRef<'ol'>) {
        const itemCount = React.Children.toArray(children).filter(React.isValidElement).length
        const digits = String(Math.max(1, (start ?? 1) + itemCount - 1)).length
        return (
          <ol start={start} className={cn('pi-ol', className)} style={{ paddingLeft: `calc(${digits}ch + 1.5em)` }}>
            {children}
          </ol>
        )
      },
      li({ children, className }: React.ComponentPropsWithoutRef<'li'>) {
        return <li className={cn('pi-li', className)}>{children}</li>
      },

      p({ children }: React.ComponentPropsWithoutRef<'p'>) {
        return <p className="pi-p">{children}</p>
      },

      h1({ children }: React.ComponentPropsWithoutRef<'h1'>) {
        return <h1 className="pi-h1">{children}</h1>
      },
      h2({ children }: React.ComponentPropsWithoutRef<'h2'>) {
        return <h2 className="pi-h2">{children}</h2>
      },
      h3({ children }: React.ComponentPropsWithoutRef<'h3'>) {
        return <h3 className="pi-h3">{children}</h3>
      },
      h4({ children }: React.ComponentPropsWithoutRef<'h4'>) {
        return <h4 className="pi-h4">{children}</h4>
      },
      h5({ children }: React.ComponentPropsWithoutRef<'h5'>) {
        return <h5 className="pi-h5">{children}</h5>
      },
      h6({ children }: React.ComponentPropsWithoutRef<'h6'>) {
        return <h6 className="pi-h6">{children}</h6>
      },

      hr() {
        return <hr className="pi-hr" />
      },

      img: MarkdownImage,

      strong({ children }: React.ComponentPropsWithoutRef<'strong'>) {
        return <strong className="pi-strong">{children}</strong>
      },

      em({ children }: React.ComponentPropsWithoutRef<'em'>) {
        return <em className="pi-em">{children}</em>
      },
    }),
    [],
  )
}
