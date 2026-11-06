import * as React from 'react'
import { Check, Copy } from 'lucide-react'
import { Button } from '@pi-meme/ui/components/ui/button'
import { cn } from '@pi-meme/ui/lib/utils'
import { usePresentationActive } from './retained-disclosure'

const ExecutionSection = React.memo(ExecutionSectionContent)
export const ToolExecutionDetails = React.memo(ToolExecutionDetailsContent)

function ToolExecutionDetailsContent({
  code,
  output,
  isScript = false,
  isRunning,
  isPaused,
  children,
}: {
  code?: string
  output: string
  isScript?: boolean
  isRunning: boolean
  isPaused: boolean
  children?: React.ReactNode
}) {
  return (
    <div className="my-2 min-w-0 overflow-hidden rounded-lg border border-border/70 bg-transparent font-mono text-xs leading-relaxed text-muted-foreground select-text">
      {code !== undefined && <div className="px-3 pt-2 font-sans text-xs">{isScript ? '执行脚本' : 'Shell'}</div>}
      {code && (
        <ExecutionSection
          text={code}
          label={isScript ? 'codemode 执行脚本' : '执行命令'}
          copyLabel={isScript ? '复制脚本' : '复制命令'}
          className="max-h-[min(10rem,30dvh)] text-foreground/90"
        />
      )}
      <div className={cn(code !== undefined && 'border-t border-border/50')}>
        <ExecutionSection
          text={output}
          label="执行输出"
          copyLabel="复制输出"
          placeholder={isRunning ? (isPaused ? '已暂停，等待输出' : '等待输出…') : '无输出'}
          className="max-h-[min(16rem,40dvh)]"
        >
          {children}
        </ExecutionSection>
      </div>
    </div>
  )
}

function ExecutionSectionContent({
  text,
  label,
  copyLabel,
  placeholder,
  className,
  children,
}: {
  text: string
  label: string
  copyLabel: string
  placeholder?: string
  className: string
  children?: React.ReactNode
}) {
  const active = usePresentationActive()
  const viewportRef = React.useRef<HTMLDivElement>(null)
  const [copyState, setCopyState] = React.useState<'idle' | 'copied' | 'failed'>('idle')
  const retained = React.useRef({ text, placeholder, children })
  const presentation = active ? { text, placeholder, children } : retained.current
  const updateOverflow = React.useCallback(() => {
    const viewport = viewportRef.current
    if (!active || !viewport) return
    const top = viewport.scrollTop
    const overflowTop = String(top > 1)
    const overflowBottom = String(viewport.scrollHeight - viewport.clientHeight - top > 1)
    if (viewport.dataset.overflowTop !== overflowTop) viewport.dataset.overflowTop = overflowTop
    if (viewport.dataset.overflowBottom !== overflowBottom) viewport.dataset.overflowBottom = overflowBottom
  }, [active])

  React.useLayoutEffect(() => {
    if (active) retained.current = { text, placeholder, children }
    // 普通 pre 随正文自然增高，由尺寸观察在同次绘制前更新，避免每批输出强制提前布局。
    // 自定义正文可能只改变内部溢出而不改变外框，仍保留同步测量。
    if (children != null || typeof ResizeObserver === 'undefined') updateOverflow()
  }, [active, text, placeholder, children, updateOverflow])

  React.useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!active || !viewport || typeof ResizeObserver === 'undefined') return
    updateOverflow()
    const observer = new ResizeObserver(updateOverflow)
    observer.observe(viewport)
    if (viewport.firstElementChild) observer.observe(viewport.firstElementChild)
    return () => observer.disconnect()
  }, [active, updateOverflow, children])

  React.useEffect(() => {
    if (copyState === 'idle') return
    const timer = setTimeout(setCopyState, 2000, 'idle')
    return () => clearTimeout(timer)
  }, [copyState])

  const feedback = copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败，请重试' : copyLabel

  return (
    <div className="group/execution-section relative min-w-0">
      <div
        ref={viewportRef}
        role="region"
        aria-label={label}
        tabIndex={0}
        onScroll={updateOverflow}
        className={cn(
          'scroll-fade overflow-auto overscroll-contain py-3 pl-3 pr-12 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring',
          className,
        )}
      >
        {presentation.children ?? (
          <pre className="whitespace-pre-wrap [overflow-wrap:anywhere]">
            {presentation.text || presentation.placeholder}
          </pre>
        )}
      </div>
      {text && (
        <Button
          variant="ghost"
          size="icon-sm"
          title={feedback}
          aria-label={feedback}
          className="absolute right-2 top-2 text-muted-foreground opacity-0 hover:bg-transparent hover:text-foreground group-hover/execution-section:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text)
              setCopyState('copied')
            } catch {
              setCopyState('failed')
            }
          }}
        >
          {copyState === 'copied' ? <Check /> : <Copy />}
        </Button>
      )}
    </div>
  )
}
