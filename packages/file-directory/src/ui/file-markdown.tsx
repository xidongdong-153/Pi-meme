import { isValidElement, memo, useMemo, type ComponentProps } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { TooltipHint } from '@pi-meme/ui/components/ui/tooltip'
import { normalizeCodeLanguage, useHighlighter } from '@pi-meme/ui/lib/use-highlighter'

function HighlightedCodeBlock({ code, language }: { code: string; language: string }) {
  const highlighter = useHighlighter()
  const html = useMemo(() => {
    const lang = normalizeCodeLanguage(language)
    if (!highlighter?.getLoadedLanguages().includes(lang)) return
    try {
      return highlighter.codeToHtml(code, {
        lang,
        themes: { light: 'github-light-default', dark: 'github-dark-default' },
        defaultColor: 'light-dark()',
        rootStyle: false,
      })
    } catch {
      return undefined
    }
  }, [code, highlighter, language])

  return html ? (
    <div dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    <pre>
      <code className={`language-${language}`}>{code}</code>
    </pre>
  )
}

const markdownComponents: Components = {
  pre: ({ children }) => {
    if (isValidElement<ComponentProps<'code'>>(children) && children.type === 'code') {
      const { className, children: code } = children.props
      const language = /(?:^|\s)language-(\S+)/.exec(className ?? '')?.[1]
      if (language && typeof code === 'string') return <HighlightedCodeBlock code={code} language={language} />
    }
    return <pre>{children}</pre>
  },
  a: ({ title, href, children }) => (
    <TooltipHint content={title}>
      <a href={href}>{children}</a>
    </TooltipHint>
  ),
  img: ({ title, src, alt, width, height }) => (
    <TooltipHint content={title}>
      <img src={src} alt={alt} width={width} height={height} />
    </TooltipHint>
  ),
}
const markdownPlugins = [remarkGfm]

export const FileMarkdown = memo(({ children }: { children: string }) => {
  return (
    <div className="file-markdown overflow-auto p-5 text-sm select-text">
      <Markdown remarkPlugins={markdownPlugins} components={markdownComponents}>
        {children}
      </Markdown>
    </div>
  )
})
