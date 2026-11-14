import { useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  Copy,
  Download,
  Maximize2,
  MessageSquare,
  MoreHorizontal,
  PanelRightOpen,
  SlidersHorizontal,
} from 'lucide-react'
import type { VisualizationDocument, VisualizationState } from '@pi-meme/contracts/visualize'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Input } from '@pi-meme/ui/components/ui/input'
import { Dialog, DialogContent, DialogTitle } from '@pi-meme/ui/components/ui/dialog'
import { Popover, PopoverAnchor, PopoverContent } from '@pi-meme/ui/components/ui/popover'
import { TooltipHint } from '@pi-meme/ui/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@pi-meme/ui/components/ui/dropdown-menu'
import { getVisualizationStateStore } from './visualization-state'
import { VisualizationFrame, type VisualizationFrameHandle } from './visualization-frame'
import { VisualizationControls } from './visualization-controls'
import {
  copyVisualizationImage,
  createStandaloneVisualization,
  createVisualizationPng,
  downloadVisualizationFile,
  visualizationFileName,
  withVisualizationExport,
} from './visualization-export'

export function VisualizationPreview({
  document,
  storageKey,
  rich,
  onOpen,
  onSubmit,
  expanded = false,
  onEscape,
}: {
  document: VisualizationDocument
  storageKey: string
  rich: boolean
  onOpen?: () => void
  onSubmit: (text: string, state: VisualizationState) => Promise<boolean>
  expanded?: boolean
  onEscape?: () => void
}) {
  const store = useMemo(() => getVisualizationStateStore(storageKey, document), [storageKey, document])
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const frame = useRef<VisualizationFrameHandle>(null)
  const expandTrigger = useRef<HTMLButtonElement>(null)
  const feedback = useRef<HTMLInputElement>(null)
  const [controls, setControls] = useState(false)
  const [adjusting, setAdjusting] = useState(false)
  const [enlarged, setEnlarged] = useState(false)
  const [pending, setPending] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const nextFocus = useRef<'controls' | 'feedback' | null>(null)

  const capture = () => {
    if (!frame.current) throw new Error('可视化尚未就绪')
    return frame.current.capture()
  }
  const run = (name: string, operation: () => Promise<void>) => {
    setPending(name)
    setError('')
    setNotice('')
    void withVisualizationExport(store, operation)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setPending(''))
  }
  const unsupported = !rich && Boolean(document.libraries?.length)
  const tools = (
    <Popover open={controls} onOpenChange={setControls}>
      <PopoverAnchor asChild>
        <div className="flex shrink-0 items-center gap-1">
          {!expanded && (
            <TooltipHint content="放大查看">
              <Button
                ref={expandTrigger}
                variant="ghost"
                size="icon-sm"
                aria-label="放大查看可视化"
                onClick={() => setEnlarged(true)}
              >
                <Maximize2 className="size-4" />
              </Button>
            </TooltipHint>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="可视化操作">
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side="bottom"
              align="end"
              onCloseAutoFocus={(event) => {
                const target = nextFocus.current
                nextFocus.current = null
                if (!target) return
                event.preventDefault()
                if (target === 'controls') setControls(true)
                else requestAnimationFrame(() => feedback.current?.focus())
              }}
            >
              <div className="px-2.5 py-1.5 text-xs text-muted-foreground">第 {document.revision} 版</div>
              {onOpen && (
                <DropdownMenuItem onSelect={onOpen}>
                  <PanelRightOpen />
                  在右侧打开
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onSelect={() => {
                  nextFocus.current = 'feedback'
                  setAdjusting(true)
                }}
              >
                <MessageSquare />
                调整要求
              </DropdownMenuItem>
              {document.controls.length > 0 && (
                <DropdownMenuItem
                  onSelect={() => {
                    nextFocus.current = 'controls'
                  }}
                >
                  <SlidersHorizontal />
                  设计参数
                </DropdownMenuItem>
              )}
              {rich && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={Boolean(pending) || unsupported}
                    onSelect={() =>
                      run('copy', async () => {
                        await copyVisualizationImage(capture)
                        setNotice('已复制图像')
                      })
                    }
                  >
                    <Copy />
                    {pending === 'copy' ? '正在复制…' : '复制为图像'}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={Boolean(pending) || unsupported}
                    onSelect={() =>
                      run('png', async () => {
                        const blob = await createVisualizationPng(capture)
                        downloadVisualizationFile(blob, visualizationFileName(document, 'png'))
                      })
                    }
                  >
                    <Download />
                    {pending === 'png' ? '正在生成…' : '下载 PNG'}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={Boolean(pending) || unsupported}
                    onSelect={() =>
                      run('html', async () => {
                        const blob = await createStandaloneVisualization(document, store.getSnapshot().state)
                        downloadVisualizationFile(blob, visualizationFileName(document, 'html'))
                      })
                    }
                  >
                    <Download />
                    {pending === 'html' ? '正在导出…' : '导出 HTML'}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </PopoverAnchor>
      {document.controls.length > 0 && (
        <PopoverContent side="bottom" align="end" className="w-[min(28rem,calc(100vw-2rem))]">
          <VisualizationControls document={document} store={store} />
        </PopoverContent>
      )}
    </Popover>
  )

  return (
    <section
      className="min-w-0 w-full space-y-3"
      style={
        expanded
          ? undefined
          : {
              maxWidth: document.layout === 'wide' ? 1024 : 736,
            }
      }
      aria-label={`可视化：${document.title}`}
    >
      <header className={`flex min-w-0 items-start justify-between gap-3 ${expanded ? 'pr-6' : ''}`}>
        {expanded ? (
          <DialogTitle className="min-w-0 break-words text-base font-medium">{document.title}</DialogTitle>
        ) : (
          <h3 className="min-w-0 break-words font-medium">{document.title}</h3>
        )}
        {tools}
      </header>
      {unsupported ? (
        <p role="alert" className="text-sm text-destructive">
          当前 Host 不支持此可视化所需的运行环境，请更新 Host。
        </p>
      ) : (
        <VisualizationFrame ref={frame} document={document} store={store} rich={rich} onEscape={onEscape} />
      )}
      {pending && (
        <p role="status" className="text-sm text-muted-foreground">
          {pending === 'copy' ? '正在复制图像…' : pending === 'png' ? '正在生成 PNG…' : '正在导出 HTML…'}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      {error && (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="min-w-0 break-words text-sm text-destructive">
            {error}
          </p>
          {error.includes('下载 PNG') && (
            <Button
              variant="outline"
              size="sm"
              disabled={Boolean(pending)}
              onClick={() =>
                run('png', async () => {
                  downloadVisualizationFile(
                    await createVisualizationPng(capture),
                    visualizationFileName(document, 'png'),
                  )
                })
              }
            >
              下载 PNG
            </Button>
          )}
        </div>
      )}
      {adjusting && (
        <form
          className="flex min-w-0 flex-wrap gap-2"
          onSubmit={async (event) => {
            event.preventDefault()
            const current = store.getSnapshot()
            if (!current.draft.trim() || current.sending) return
            store.setSending(true)
            setError('')
            try {
              if (await onSubmit(current.draft, current.state)) {
                if (store.getSnapshot().draft === current.draft) store.setDraft('')
                setAdjusting(false)
              }
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause))
            } finally {
              store.setSending(false)
            }
          }}
        >
          <Input
            ref={feedback}
            aria-label="调整可视化要求"
            placeholder="描述调整要求…"
            className="min-w-0 flex-1 basis-40"
            value={snapshot.draft}
            disabled={snapshot.sending}
            onChange={(event) => store.setDraft(event.target.value)}
          />
          <Button type="submit" disabled={snapshot.sending || !snapshot.draft.trim()}>
            {snapshot.sending ? '发送中…' : '发送'}
          </Button>
          <Button variant="ghost" type="button" onClick={() => setAdjusting(false)}>
            收起
          </Button>
        </form>
      )}
      {!expanded && (
        <Dialog open={enlarged} onOpenChange={setEnlarged}>
          <DialogContent
            aria-describedby={undefined}
            className="w-[calc(100vw-2rem)] max-w-[1280px] overflow-y-auto p-5"
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              expandTrigger.current?.focus()
            }}
          >
            <VisualizationPreview
              document={document}
              storageKey={storageKey}
              rich={rich}
              onOpen={
                onOpen
                  ? () => {
                      setEnlarged(false)
                      onOpen()
                    }
                  : undefined
              }
              onSubmit={onSubmit}
              expanded
              onEscape={() => setEnlarged(false)}
            />
          </DialogContent>
        </Dialog>
      )}
    </section>
  )
}
