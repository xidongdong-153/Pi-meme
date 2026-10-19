import { memo } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { MarkdownStreamingContext, useMarkdownComponents } from './markdown-components'

export const MarkdownContent = memo(
  ({ children, isStreaming = false }: { children: string; isStreaming?: boolean }) => {
    const components = useMarkdownComponents()
    return (
      <MarkdownStreamingContext.Provider value={isStreaming}>
        <div className="pi-markdown">
          <Markdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={components}>
            {children}
          </Markdown>
        </div>
      </MarkdownStreamingContext.Provider>
    )
  },
)
