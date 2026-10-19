import * as React from 'react'
import { Code, Copy, Download, Maximize2, MoreHorizontal } from 'lucide-react'
import { Button } from '@pi-meme/ui/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@pi-meme/ui/components/ui/dropdown-menu'
import { CodeBlock } from './code-block'
import { ImageViewer } from './image-viewer'
import { readMermaidTheme, renderMermaid, type MermaidTheme } from './mermaid-renderer'

interface MermaidBlockProps {
  code: string
  isStreaming: boolean
}

export function MermaidBlock({ code, isStreaming }: MermaidBlockProps) {
  const [theme, setTheme] = React.useState<MermaidTheme | null>(null)
  const [result, setResult] = React.useState<{
    code: string
    theme: MermaidTheme
    svg?: string
    error?: string
  } | null>(null)
  const [showSource, setShowSource] = React.useState(false)
  const [activeIndex, setActiveIndex] = React.useState<number | null>(null)
  const [notice, setNotice] = React.useState('')
  const triggerRef = React.useRef<HTMLButtonElement>(null)

  React.useEffect(() => {
    const update = () => {
      const next = readMermaidTheme()
      setTheme((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next))
    }
    update()
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-appearance'] })
    return () => observer.disconnect()
  }, [])

  React.useEffect(() => {
    if (isStreaming || !theme) return
    let current = true
    void renderMermaid(code, theme).then(
      (svg) => {
        if (current) setResult({ code, theme, svg })
      },
      () => {
        if (current) setResult({ code, theme, error: '图表无法渲染，请检查源码。' })
      },
    )
    return () => {
      current = false
    }
  }, [code, isStreaming, theme])

  const current = !isStreaming && result?.code === code && result.theme === theme ? result : null
  const svg = current?.svg
  const images = React.useMemo(
    () =>
      svg
        ? [{ type: 'image' as const, mimeType: 'image/svg+xml', data: `data:image/svg+xml,${encodeURIComponent(svg)}` }]
        : [],
    [svg],
  )

  const openViewer = (event: React.MouseEvent<HTMLButtonElement>) => {
    triggerRef.current = event.currentTarget
    setActiveIndex(0)
  }

  const copySource = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setNotice('已复制源码')
    } catch {
      setNotice('复制失败，请重试。')
    }
  }

  const download = () => {
    if (!svg) return
    try {
      const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }))
      const link = document.createElement('a')
      link.href = url
      link.download = 'diagram.svg'
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 0)
    } catch {
      setNotice('下载失败，请重试。')
    }
  }

  return (
    <div className="my-3 min-w-0 max-w-full" role="group" aria-label="Mermaid 图表">
      <div className="mb-2 flex min-h-8 items-center justify-end gap-1">
        {notice && (
          <span role="status" className="mr-auto text-xs text-muted-foreground">
            {notice}
          </span>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="图表操作">
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="bottom" align="end">
            <DropdownMenuItem disabled={!svg} onSelect={() => setShowSource((value) => !value)}>
              <Code />
              {showSource ? '查看图表' : '查看源码'}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void copySource()}>
              <Copy />
              复制源码
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!svg} onSelect={download}>
              <Download />
              下载 SVG
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="ghost" size="sm" disabled={!svg} onClick={openViewer}>
          <Maximize2 className="size-3.5" />
          展开图表
        </Button>
      </div>
      {svg && !showSource ? (
        <button
          type="button"
          className="block w-full cursor-zoom-in rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="展开 Mermaid 图表"
          onClick={openViewer}
        >
          <img
            src={images[0].data}
            alt="Mermaid 图表"
            className="mx-auto max-h-[28rem] max-w-full object-contain"
            onError={() => theme && setResult({ code, theme, error: '图表无法显示，请查看源码。' })}
          />
        </button>
      ) : (
        <>
          {current?.error && (
            <p role="status" className="text-xs text-muted-foreground">
              {current.error}
            </p>
          )}
          <CodeBlock code={code} language="mermaid" />
        </>
      )}
      <ImageViewer
        images={images}
        activeIndex={activeIndex}
        onActiveIndexChange={setActiveIndex}
        triggerRef={triggerRef}
        variant="diagram"
        actions={
          <Button variant="ghost" size="icon-sm" aria-label="下载 SVG" onClick={download}>
            <Download className="size-4" />
          </Button>
        }
      />
    </div>
  )
}
