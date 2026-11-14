import { memo } from 'react'
import Markdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { MarkdownStreamingContext, useMarkdownComponents } from './markdown-components'
import { fileLinkTarget } from './markdown-link'
import { MessageImagePresentationContext, type ImagePresentation } from './message-image'

function markdownUrlTransform(url: string, key: string) {
  return (key === 'href' || key === 'src') && fileLinkTarget(url) ? url : defaultUrlTransform(url)
}

export const MarkdownContent = memo(
  ({
    children,
    isStreaming = false,
    imagePresentation = 'inline',
  }: {
    children: string
    isStreaming?: boolean
    imagePresentation?: ImagePresentation
  }) => {
    const components = useMarkdownComponents()
    return (
      <MarkdownStreamingContext.Provider value={isStreaming}>
        <MessageImagePresentationContext value={imagePresentation}>
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
        </MessageImagePresentationContext>
      </MarkdownStreamingContext.Provider>
    )
  },
)
