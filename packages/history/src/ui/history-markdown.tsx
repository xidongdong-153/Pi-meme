import * as React from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'

const alertLabels: Record<string, string> = {
  note: 'Note',
  tip: 'Tip',
  important: 'Important',
  warning: 'Warning',
  caution: 'Caution',
}

function renderBlockquote(children: React.ReactNode) {
  const parts = React.Children.toArray(children)
  const firstIndex = parts.findIndex(React.isValidElement)
  const first = parts[firstIndex]
  if (React.isValidElement<{ children?: React.ReactNode }>(first)) {
    const text = React.Children.toArray(first.props.children)
    const firstText = typeof text[0] === 'string' ? text[0] : ''
    const marker = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i.exec(firstText)
    if (marker) {
      const type = marker[1].toLowerCase()
      const remaining = firstText.slice(marker[0].length)
      return (
        <div className={`pi-alert pi-alert-${type}`}>
          <div className="pi-alert-title">{alertLabels[type]}</div>
          <div className="pi-alert-body">
            <p className="pi-p">
              {remaining}
              {text.slice(1)}
            </p>
            {parts.slice(firstIndex + 1)}
          </div>
        </div>
      )
    }
  }
  return <blockquote className="pi-blockquote">{children}</blockquote>
}

export function HistoryMarkdown({ children }: { children: string }) {
  return (
    <div className="pi-markdown">
      <Markdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          p: ({ children }) => <p className="pi-p">{children}</p>,
          h1: ({ children }) => <h1 className="pi-h1">{children}</h1>,
          h2: ({ children }) => <h2 className="pi-h2">{children}</h2>,
          h3: ({ children }) => <h3 className="pi-h3">{children}</h3>,
          h4: ({ children }) => <h4 className="pi-h4">{children}</h4>,
          h5: ({ children }) => <h5 className="pi-h5">{children}</h5>,
          h6: ({ children }) => <h6 className="pi-h6">{children}</h6>,
          ul: ({ children }) => <ul className="pi-ul">{children}</ul>,
          ol: ({ children, start }) => {
            const digits = String(Math.max(1, Number(start ?? 1) + React.Children.count(children) - 1)).length
            return (
              <ol start={start} className="pi-ol" style={{ paddingLeft: `${digits + 1.5}ch` }}>
                {children}
              </ol>
            )
          },
          li: ({ children, className }) => (
            <li className={['pi-li', className].filter(Boolean).join(' ')}>{children}</li>
          ),
          blockquote: ({ children }) => renderBlockquote(children),
          code: ({ children, className }) => <code className={className ?? 'pi-inline-code'}>{children}</code>,
          pre: ({ children }) => <pre className="pi-code-block overflow-auto p-3">{children}</pre>,
          strong: ({ children }) => <strong className="pi-strong">{children}</strong>,
          em: ({ children }) => <em className="pi-em">{children}</em>,
          hr: () => <hr className="pi-hr" />,
          img: ({ src, alt }) => <img src={src} alt={alt} loading="lazy" className="pi-img" />,
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" className="pi-link">
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="pi-table-wrapper">
              <table className="pi-table">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="pi-thead">{children}</thead>,
          tr: ({ children }) => <tr className="pi-tr">{children}</tr>,
          th: ({ children, style }) => (
            <th className="pi-th" style={style}>
              {children}
            </th>
          ),
          td: ({ children, style }) => (
            <td className="pi-td" style={style}>
              {children}
            </td>
          ),
        }}
      >
        {children}
      </Markdown>
    </div>
  )
}
