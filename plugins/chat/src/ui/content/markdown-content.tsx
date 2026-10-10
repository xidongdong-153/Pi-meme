import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { useMarkdownComponents } from './markdown-components'

export function MarkdownContent({ children }: { children: string }) {
  const components = useMarkdownComponents()
  return (
    <div className="pi-markdown">
      <Markdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={components}>
        {children}
      </Markdown>
    </div>
  )
}
