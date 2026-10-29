import { lazy, Suspense, useEffect, useState } from 'react'
import { ChevronDown, Copy, Download, FolderOpen, RefreshCw, ExternalLink } from 'lucide-react'
import type { FilePreview, SessionRef } from '@pi-meme/contracts/app-host'
import type { DesktopBridge, ProjectApp } from '@pi-meme/contracts/desktop'
import { MarkdownContent } from '@pi-meme/chat/ui/content/markdown-content'
import { MarkdownFileSessionContext, MarkdownWorkingDirectoryContext } from '@pi-meme/chat/ui/content/markdown-link'
import { Button } from '@pi-meme/ui/components/ui/button'
import { FileIcon } from '@pi-meme/ui/components/file-icon'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@pi-meme/ui/components/ui/dropdown-menu'

const FileEditor = lazy(() =>
  import('@pi-meme/file-directory/ui/file-editor').then((module) => ({ default: module.FileEditor })),
)
function noop() {}
export type LinkedFileTab = { id: string; path: string; session: SessionRef; line?: number; column?: number }

export function LinkedFilePanel({
  tab,
  load,
  bridge,
  local,
}: {
  tab: LinkedFileTab
  load: (session: SessionRef, path: string) => Promise<FilePreview>
  bridge: Pick<DesktopBridge, 'getProjectApps' | 'openProject'>
  local: boolean
}) {
  const [preview, setPreview] = useState<FilePreview>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [reload, setReload] = useState(0)
  const [source, setSource] = useState(Boolean(tab.line))
  const [apps, setApps] = useState<ProjectApp[]>([])
  const [appsLoading, setAppsLoading] = useState(false)
  const [opening, setOpening] = useState(false)
  const [notice, setNotice] = useState('')
  const filename = tab.path.split(/[\\/]/).at(-1) || tab.path
  const directory = tab.path.replace(/[\\/][^\\/]*$/, '')
  const markdown = /\.(?:md|markdown|mdx)$/i.test(filename)
  useEffect(() => {
    let active = true
    setLoading(true)
    setPreview(undefined)
    setError('')
    void load(tab.session, tab.path)
      .then(
        (value) => {
          if (active) setPreview(value)
        },
        (cause) => {
          if (active) setError(String(cause))
        },
      )
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [load, tab.session, tab.path, reload])
  useEffect(() => {
    if (tab.line) setSource(true)
  }, [tab.line, tab.column])
  const openIn = async (app: ProjectApp, folder = false) => {
    setOpening(true)
    setNotice('')
    try {
      await bridge.openProject(app.id, folder ? directory : tab.path)
    } catch (cause) {
      setNotice(String(cause))
    } finally {
      setOpening(false)
    }
  }
  const download = () => {
    if (!preview || preview.kind === 'unsupported') return
    const url =
      preview.kind === 'image'
        ? preview.dataUrl
        : URL.createObjectURL(new Blob([preview.content], { type: 'text/plain;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    anchor.click()
    if (preview.kind === 'text') setTimeout(URL.revokeObjectURL, 1000, url)
  }
  return (
    <section aria-label={`文件预览：${filename}`} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 text-xs" title={tab.path}>
          <FileIcon path={tab.path} />
          <span className="truncate">{tab.path}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {markdown && (
            <Button size="sm" variant="ghost" onClick={() => setSource(!source)}>
              {source ? '预览' : '源码'}
            </Button>
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="重新读取文件"
            disabled={loading}
            onClick={() => setReload((value) => value + 1)}
          >
            <RefreshCw className="size-3.5" />
          </Button>
          <DropdownMenu
            onOpenChange={(open) => {
              if (!open || !local) return
              setAppsLoading(true)
              void bridge
                .getProjectApps()
                .then(setApps, (cause) => setNotice(String(cause)))
                .finally(() => setAppsLoading(false))
            }}
          >
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" disabled={opening}>
                打开方式 <ChevronDown className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="bottom" sideOffset={8}>
              {appsLoading ? <DropdownMenuItem disabled>正在读取应用…</DropdownMenuItem> : null}
              {local &&
                apps
                  .filter((app) => app.id !== 'finder')
                  .map((app) => (
                    <DropdownMenuItem key={app.id} onSelect={() => void openIn(app)}>
                      <ExternalLink />
                      {app.name}
                    </DropdownMenuItem>
                  ))}
              {local && apps.some((app) => app.id === 'finder') ? (
                <DropdownMenuItem
                  onSelect={() =>
                    void openIn(
                      apps.find((app) => app.id === 'finder')!,
                      true,
                    )
                  }
                >
                  <FolderOpen />
                  打开所在文件夹
                </DropdownMenuItem>
              ) : null}
              {local && apps.length ? <DropdownMenuSeparator /> : null}
              <DropdownMenuItem
                onSelect={() => {
                  void navigator.clipboard.writeText(tab.path).then(
                    () => setNotice('路径已复制'),
                    () => setNotice('复制失败'),
                  )
                }}
              >
                <Copy />
                复制路径
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!preview || preview.kind === 'unsupported'} onSelect={download}>
                <Download />
                下载文件
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {notice ? (
        <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
          {notice}
        </p>
      ) : null}
      {loading ? (
        <p role="status" className="p-5 text-sm text-muted-foreground">
          正在读取文件…
        </p>
      ) : error ? (
        <p role="alert" className="p-5 text-sm text-destructive">
          {error}
        </p>
      ) : preview?.kind === 'text' ? (
        markdown && !source ? (
          <MarkdownFileSessionContext value={tab.session}>
            <MarkdownWorkingDirectoryContext value={directory}>
              <div className="min-h-0 flex-1 overflow-auto p-5 select-text">
                <MarkdownContent>{preview.content}</MarkdownContent>
              </div>
            </MarkdownWorkingDirectoryContext>
          </MarkdownFileSessionContext>
        ) : (
          <Suspense fallback={<p className="p-5 text-sm text-muted-foreground">正在加载代码…</p>}>
            <FileEditor
              key={`${tab.path}:${reload}`}
              path={tab.path}
              content={preview.content}
              editable={false}
              onChange={noop}
              line={tab.line}
              column={tab.column}
            />
          </Suspense>
        )
      ) : preview?.kind === 'image' ? (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
          <img src={preview.dataUrl} alt={filename} className="max-h-full max-w-full object-contain" />
        </div>
      ) : preview?.kind === 'unsupported' ? (
        <p className="p-5 text-sm text-muted-foreground">
          {preview.reason === 'too-large' ? '文件超过预览上限：文本 1 MiB，图片 8 MiB。' : '此文件格式暂不支持预览。'}
        </p>
      ) : null}
    </section>
  )
}
