import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'

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
          ul: ({ children }) => <ul className="pi-ul">{children}</ul>,
          ol: ({ children }) => <ol className="pi-ol">{children}</ol>,
          li: ({ children }) => <li className="pi-li">{children}</li>,
          blockquote: ({ children }) => <blockquote className="pi-blockquote">{children}</blockquote>,
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
          th: ({ children }) => <th className="pi-th">{children}</th>,
          td: ({ children }) => <td className="pi-td">{children}</td>,
        }}
      >
        {children}
      </Markdown>
    </div>
  )
}
