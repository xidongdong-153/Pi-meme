import { memo } from 'react'
import Markdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { MarkdownStreamingContext, useMarkdownComponents } from './markdown-components'
import { fileLinkTarget } from './markdown-link'

function markdownUrlTransform(url: string, key: string) {
  return key === 'href' && fileLinkTarget(url) ? url : defaultUrlTransform(url)
}

export const MarkdownContent = memo(
  ({ children, isStreaming = false }: { children: string; isStreaming?: boolean }) => {
    const components = useMarkdownComponents()
    return (
      <MarkdownStreamingContext.Provider value={isStreaming}>
        <div className="pi-markdown">
          <Markdown
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[rehypeKatex]}
            components={components}
            urlTransform={markdownUrlTransform}
          >
            {children}
          </Markdown>
        </div>
      </MarkdownStreamingContext.Provider>
    )
  },
)
