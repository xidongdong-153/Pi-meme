import * as React from 'react'
import { ChevronRight } from 'lucide-react'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@pi-meme/ui/components/ui/collapsible'
import { FileIcon } from '@pi-meme/ui/components/file-icon'
import { cn } from '@pi-meme/ui/lib/utils'
import { normalizeCodeLanguage, useHighlighter } from '@pi-meme/ui/lib/use-highlighter'

const codeLanguages: Record<string, [label: string, extension: string]> = {
  text: ['TEXT', ''],
  plaintext: ['TEXT', ''],
  plain: ['TEXT', ''],
  txt: ['TEXT', ''],
  typescript: ['TypeScript', 'ts'],
  ts: ['TypeScript', 'ts'],
  javascript: ['JavaScript', 'js'],
  js: ['JavaScript', 'js'],
  tsx: ['TSX', 'tsx'],
  jsx: ['JSX', 'jsx'],
  python: ['Python', 'py'],
  py: ['Python', 'py'],
  html: ['HTML', 'html'],
  css: ['CSS', 'css'],
  json: ['JSON', 'json'],
  jsonc: ['JSONC', 'jsonc'],
  markdown: ['Markdown', 'md'],
  md: ['Markdown', 'md'],
  shellscript: ['Shell', 'sh'],
  bash: ['Bash', 'sh'],
  sh: ['Shell', 'sh'],
  yaml: ['YAML', 'yaml'],
  yml: ['YAML', 'yaml'],
  sql: ['SQL', 'sql'],
  rust: ['Rust', 'rs'],
  rs: ['Rust', 'rs'],
  go: ['Go', 'go'],
  java: ['Java', 'java'],
  c: ['C', 'c'],
  cpp: ['C++', 'cpp'],
  csharp: ['C#', 'cs'],
  cs: ['C#', 'cs'],
  vue: ['Vue', 'vue'],
  svelte: ['Svelte', 'svelte'],
  ruby: ['Ruby', 'rb'],
  rb: ['Ruby', 'rb'],
  php: ['PHP', 'php'],
  swift: ['Swift', 'swift'],
  kotlin: ['Kotlin', 'kt'],
  kt: ['Kotlin', 'kt'],
  toml: ['TOML', 'toml'],
  diff: ['Diff', 'diff'],
  docker: ['Dockerfile', 'dockerfile'],
  dockerfile: ['Dockerfile', 'dockerfile'],
}

export interface CodeBlockProps extends React.HTMLAttributes<HTMLDivElement> {
  code: string
  language?: string
}

export function CodeBlock({ code, language = 'text', className, ...props }: CodeBlockProps) {
  const [open, setOpen] = React.useState(true)
  const [copied, setCopied] = React.useState(false)
  const normalizedLanguage = normalizeCodeLanguage(language)
  const [languageLabel, extension] = Object.hasOwn(codeLanguages, normalizedLanguage)
    ? codeLanguages[normalizedLanguage]
    : [language, '']
  const highlighter = useHighlighter()
  const html = React.useMemo(() => {
    if (!highlighter) return ''
    try {
      return highlighter.codeToHtml(code, {
        lang: normalizeCodeLanguage(language),
        themes: { light: 'github-light-default', dark: 'github-dark-default' },
        defaultColor: 'light-dark()',
      })
    } catch {
      // 未标记或不支持的语言保留原文。
      return ''
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
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <div className={cn('pi-code-block relative my-4 min-w-0 max-w-full font-mono text-sm', className)} {...props}>
        <div className="pi-code-block-header flex min-h-8 items-center justify-between gap-4 pb-3 pl-4 select-none">
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              className="group/code-language h-8 min-w-0 justify-start gap-2 rounded-sm px-0 py-1 font-sans text-xs font-medium text-muted-foreground hover:bg-transparent hover:text-foreground"
              aria-label={open ? '折叠代码块' : '展开代码块'}
              title={open ? '折叠代码块' : '展开代码块'}
            >
              {extension ? (
                <FileIcon path={`code.${extension}`} />
              ) : (
                <span aria-hidden="true" className="mx-1 size-1.5 shrink-0 rounded-full bg-muted-foreground/70" />
              )}
              <span className="truncate">{languageLabel}</span>
              <ChevronRight
                className={cn(
                  'size-3 opacity-0 transition-[opacity,rotate] duration-200 ease-out motion-reduce:transition-none group-hover/code-language:opacity-100 group-focus-visible/code-language:opacity-100',
                  open ? 'rotate-90' : 'opacity-100',
                )}
              />
            </Button>
          </CollapsibleTrigger>
          <Button
            variant="ghost"
            size="xs"
            className="h-7 shrink-0 border-0 bg-transparent px-1 font-sans text-xs font-normal text-muted-foreground shadow-none hover:bg-transparent hover:text-foreground"
            onClick={handleCopy}
            aria-label={copied ? '已复制' : '复制代码'}
          >
            {copied ? '已复制' : '复制'}
          </Button>
        </div>
        <div
          data-state={open ? 'open' : 'closed'}
          className="grid transition-[grid-template-rows,opacity] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] data-[state=closed]:grid-rows-[0fr] data-[state=closed]:opacity-0 data-[state=open]:grid-rows-[1fr] data-[state=open]:opacity-100"
        >
          <CollapsibleContent forceMount aria-hidden={!open} inert={!open} className="min-h-0 overflow-hidden">
            {html ? (
              <div
                className="pi-code-block-content overflow-auto px-4 pb-2 text-sm leading-[1.75] select-text"
                dangerouslySetInnerHTML={{ __html: html }}
              />
            ) : (
              <pre className="pi-code-block-content overflow-auto px-4 pb-2 text-sm leading-[1.75] text-foreground select-text font-mono">
                <code>{code}</code>
              </pre>
            )}
          </CollapsibleContent>
        </div>
      </div>
    </Collapsible>
  )
}
