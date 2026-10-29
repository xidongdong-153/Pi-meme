import * as React from 'react'
import { Copy, ExternalLink, Globe } from 'lucide-react'
import type { LinkPreview } from '@pi-meme/contracts/link-preview'
import type { SessionRef } from '@pi-meme/contracts/app-host'
import { Popover, PopoverAnchor, PopoverContent } from '@pi-meme/ui/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@pi-meme/ui/components/ui/tooltip'

export const MarkdownLinkContext = React.createContext<{
  loadPreview?: (url: string) => Promise<LinkPreview>
  openFile?: (path: string, location?: { line?: string; column?: string; session?: SessionRef }) => Promise<void>
}>({})
export const MarkdownWorkingDirectoryContext = React.createContext<string | undefined>(undefined)
export const MarkdownFileSessionContext = React.createContext<SessionRef | undefined>(undefined)

export function fileLinkTarget(href: string, cwd?: string) {
  if (!href || href.startsWith('#') || /^(?:https?:)?\/\//i.test(href)) return null
  const windows = /^[a-z]:[\\/]/i.test(href)
  const withoutLocation = href.replace(/:\d+(?::\d+)?$/, '')
  const fileWithLine = withoutLocation !== href && /[\\/.]/.test(withoutLocation)
  if (!windows && !fileWithLine && /^[a-z][\w+.-]*:/i.test(href) && !href.startsWith('file:')) return null
  let path = href
  if (href.startsWith('file:')) {
    try {
      const url = new URL(href)
      if (url.hostname && url.hostname !== 'localhost') return null
      path = url.pathname.replace(/^\/(?=[a-z]:\/)/i, '') + url.hash
    } catch {
      return null
    }
  }
  const location = /(?::(\d+)(?::(\d+))?|#L(\d+)(?:C(\d+))?(?:-L?\d+)?)$/.exec(path)
  if (location) path = path.slice(0, location.index)
  try {
    path = decodeURIComponent(path)
  } catch {
    // 保留不完整的 URI 编码，流式输出不应导致正文崩溃。
  }
  if (!path || /[\r\n\0]/.test(path) || (!/^[a-z]:[\\/]/i.test(path) && /^[a-z][\w+.-]*:/i.test(path))) return null
  if (cwd && !/^(?:\/|~\/|[a-z]:[\\/])/i.test(path)) path = `${cwd.replace(/[\\/]$/, '')}/${path}`
  const line = location?.[1] ?? location?.[3]
  const column = location?.[2] ?? location?.[4]
  return { path, line, column, label: `${path}${line ? `（第 ${line} 行${column ? `，第 ${column} 列` : ''}）` : ''}` }
}

function FileLink({ href, children }: { href: string; children: React.ReactNode }) {
  const cwd = React.useContext(MarkdownWorkingDirectoryContext)
  const { openFile } = React.useContext(MarkdownLinkContext)
  const session = React.useContext(MarkdownFileSessionContext)
  const target = fileLinkTarget(href, cwd)!
  const [status, setStatus] = React.useState('')
  const activate = async () => {
    try {
      if (openFile) await openFile(target.path, { line: target.line, column: target.column, session })
      else {
        await navigator.clipboard.writeText(
          target.path + (target.line ? `:${target.line}${target.column ? `:${target.column}` : ''}` : ''),
        )
        setStatus('路径已复制')
      }
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : '无法打开或复制路径')
    }
  }
  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="pi-link pi-file-link"
            onClick={() => void activate()}
            onBlur={() => setStatus('')}
          >
            {children}
            {target.line && !String(children).includes(target.line) ? (
              <span className="pi-link-location">（第 {target.line} 行）</span>
            ) : null}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="pi-path-tooltip">
          <span>{target.label}</span>
          <span className="pi-path-action">{status || (openFile ? '在标签页中打开' : '点击复制路径')}</span>
        </TooltipContent>
      </Tooltip>
      <span className="sr-only" role="status">
        {status}
      </span>
    </TooltipProvider>
  )
}

function Github({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M12 .5a12 12 0 0 0-3.79 23.38c.6.11.82-.26.82-.58v-2.23c-3.34.73-4.04-1.42-4.04-1.42-.55-1.39-1.33-1.76-1.33-1.76-1.09-.75.08-.73.08-.73 1.2.08 1.84 1.23 1.84 1.23 1.07 1.83 2.81 1.3 3.5.99.11-.78.42-1.3.76-1.6-2.66-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.23-3.22-.12-.3-.53-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.65 1.66.24 2.88.12 3.18.77.84 1.23 1.91 1.23 3.22 0 4.61-2.81 5.62-5.49 5.92.43.37.82 1.1.82 2.22v3.31c0 .32.22.7.83.58A12 12 0 0 0 12 .5Z" />
    </svg>
  )
}

function PreviewImage({ src, className }: { src: string; className: string }) {
  const [failed, setFailed] = React.useState(false)
  return failed ? null : (
    <img src={src} alt="" referrerPolicy="no-referrer" className={className} onError={() => setFailed(true)} />
  )
}

function WebLink({ href, children, title }: { href: string; children: React.ReactNode; title?: string }) {
  const { loadPreview } = React.useContext(MarkdownLinkContext)
  const [open, setOpen] = React.useState(false)
  const [result, setResult] = React.useState<{ data?: LinkPreview; failed?: boolean }>()
  const [copyStatus, setCopyStatus] = React.useState('')
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const trigger = React.useRef<HTMLAnchorElement>(null)
  const content = React.useRef<HTMLDivElement>(null)
  const url = new URL(href.startsWith('//') ? `https:${href}` : href)
  const github = url.hostname === 'github.com'
  const clear = () => clearTimeout(timer.current)
  const show = () => {
    clear()
    timer.current = setTimeout(setOpen, 300, true)
  }
  const hide = () => {
    clear()
    timer.current = setTimeout(setOpen, 180, false)
  }
  const blur = (event: React.FocusEvent) => {
    const next = event.relatedTarget as Node | null
    if (!trigger.current?.contains(next) && !content.current?.contains(next)) hide()
  }
  React.useEffect(() => () => clearTimeout(timer.current), [])
  React.useEffect(() => {
    if (!open || !loadPreview || result) return
    let active = true
    void loadPreview(url.href).then(
      (data) => {
        if (active) setResult({ data })
      },
      () => {
        if (active) setResult({ failed: true })
      },
    )
    return () => {
      active = false
    }
  }, [open, loadPreview, result, url.href])
  const data = result?.data
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <a
          ref={trigger}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="pi-link"
          title={open ? undefined : title}
          onPointerEnter={(event) => {
            if (event.pointerType !== 'touch') show()
          }}
          onPointerLeave={hide}
          onFocus={show}
          onBlur={blur}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              clear()
              setOpen(false)
            } else if (event.key === 'ArrowDown' && open) {
              event.preventDefault()
              content.current?.querySelector<HTMLAnchorElement>('a')?.focus()
            }
          }}
        >
          {github ? <Github aria-hidden="true" className="pi-link-icon" /> : null}
          {children}
        </a>
      </PopoverAnchor>
      <PopoverContent
        ref={content}
        side="bottom"
        align="start"
        sideOffset={8}
        collisionPadding={12}
        className="pi-link-preview"
        aria-label="链接预览"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={() => {
          clear()
          trigger.current?.focus()
          clear()
        }}
        onPointerEnter={clear}
        onPointerLeave={hide}
        onFocus={clear}
        onBlur={blur}
      >
        <div className="pi-link-preview-header">
          {data?.icon ? (
            <PreviewImage key={data.icon} src={data.icon} className="pi-link-site-icon" />
          ) : github ? (
            <Github aria-hidden="true" />
          ) : (
            <Globe aria-hidden="true" />
          )}
          <span className="pi-link-domain">{url.hostname}</span>
          <a href={href} target="_blank" rel="noopener noreferrer" className="pi-link-preview-open">
            打开 <ExternalLink aria-hidden="true" />
          </a>
        </div>
        {data?.image ? <PreviewImage key={data.image} src={data.image} className="pi-link-cover" /> : null}
        <div className="pi-link-preview-body">
          <p className="pi-link-preview-title">{data?.title || title || children}</p>
          {data?.description ? <p className="pi-link-preview-description">{data.description}</p> : null}
          {!result && loadPreview ? (
            <p className="pi-link-preview-description" role="status">
              正在读取网页预览…
            </p>
          ) : null}
          {result?.failed ? <p className="pi-link-preview-description">暂时无法预览，可直接打开网页。</p> : null}
          <div className="pi-link-preview-address">
            <span>{url.href}</span>
            <button
              type="button"
              aria-label="复制链接"
              title="复制链接"
              onClick={() => {
                void navigator.clipboard.writeText(href).then(
                  () => setCopyStatus('链接已复制'),
                  () => setCopyStatus('复制失败'),
                )
              }}
            >
              <Copy aria-hidden="true" />
            </button>
          </div>
          <span className="sr-only" role="status">
            {copyStatus}
          </span>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function MarkdownLink({ href, children, title }: { href?: string; children: React.ReactNode; title?: string }) {
  if (!href) return <>{children}</>
  if (fileLinkTarget(href))
    return (
      <FileLink key={href} href={href}>
        {children}
      </FileLink>
    )
  if (/^(?:https?:)?\/\//i.test(href)) {
    if (!URL.canParse(href.startsWith('//') ? `https:${href}` : href)) return <>{children}</>
    return (
      <WebLink key={href} href={href} title={title}>
        {children}
      </WebLink>
    )
  }
  return (
    <a href={href} className="pi-link" title={title}>
      {children}
    </a>
  )
}
