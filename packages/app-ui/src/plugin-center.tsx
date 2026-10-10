import { useRef, useState, type ReactNode } from 'react'
import { ChevronDown, MoreHorizontal, Puzzle, RefreshCw, Search, Upload } from 'lucide-react'
import type { PluginClient } from '@pi-meme/client/plugin-client'
import type { UiPluginDescriptor } from '@pi-meme/plugin-sdk/ui'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Input } from '@pi-meme/ui/components/ui/input'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@pi-meme/ui/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@pi-meme/ui/components/ui/dropdown-menu'
import { cn } from '@pi-meme/ui/lib/utils'

const statusNames = { active: '已启用', disabled: '已停用', pending: '等待会话空闲', failed: '加载失败' }
function presentation(plugin: UiPluginDescriptor) {
  return { name: plugin.id, description: plugin.description || '此插件未提供说明。', icon: Puzzle }
}

export function PluginCenter({
  client,
  plugins,
  errors,
  onRefresh,
  renderSettings,
  developer = false,
}: {
  client: PluginClient
  plugins: UiPluginDescriptor[]
  errors: Record<string, string>
  onRefresh: () => Promise<void>
  developer?: boolean
  renderSettings?: (id: string) => ReactNode
}) {
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'enabled' | 'disabled'>('all')
  const [directoryOpen, setDirectoryOpen] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const detail = plugins.find((plugin) => plugin.id === selected)
  const filtered = plugins.filter((plugin) => {
    const item = presentation(plugin)
    return (
      (filter === 'all' || plugin.enabled === (filter === 'enabled')) &&
      `${plugin.id} ${item.name} ${item.description}`.toLowerCase().includes(query.trim().toLowerCase())
    )
  })

  async function action(id: string, work: () => Promise<unknown>) {
    if (busy) return false
    setBusy(id)
    setError('')
    try {
      await work()
      if (work !== onRefresh) await onRefresh()
      return true
    } catch (cause) {
      setError(String(cause))
      return false
    } finally {
      setBusy('')
    }
  }

  async function upload(file?: File) {
    if (!file) return
    await action('install', async () => {
      if (file.size > 32 * 1024 * 1024) throw new Error('插件上传不能超过 32 MiB')
      const bytes = new Uint8Array(await file.arrayBuffer())
      const chunks: string[] = []
      for (let start = 0; start < bytes.length; start += 32768)
        chunks.push(String.fromCharCode(...bytes.subarray(start, start + 32768)))
      await client.installPackage(btoa(chunks.join('')))
    })
  }

  function menu(plugin: UiPluginDescriptor) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            disabled={Boolean(busy)}
            aria-label={`管理插件：${plugin.id}`}
            className="shrink-0 rounded-full text-muted-foreground"
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setSelected(plugin.id)}>查看详情</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() =>
              void action(plugin.id, () => (plugin.enabled ? client.disable(plugin.id) : client.enable(plugin.id)))
            }
          >
            {plugin.enabled ? '停用' : '启用'}
          </DropdownMenuItem>
          {developer && (
            <DropdownMenuItem onSelect={() => void action(plugin.id, () => client.reload(plugin.id))}>
              重新加载
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-destructive" onSelect={() => setRemoving(plugin.id)}>
            卸载
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  return (
    <div className="space-y-7" aria-busy={Boolean(busy)}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
          <Input
            aria-label="搜索插件"
            placeholder="搜索插件"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="rounded-full pl-9"
          />
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            aria-label="刷新插件"
            disabled={Boolean(busy)}
            onClick={() => void action('refresh', onRefresh)}
          >
            <RefreshCw className={cn(busy === 'refresh' && 'animate-spin')} />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button className="rounded-full" disabled={Boolean(busy)}>
                添加
                <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {developer && (
                <DropdownMenuItem
                  onSelect={() => {
                    setError('')
                    setDirectoryOpen(true)
                  }}
                >
                  加载 Host 目录
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => fileInput.current?.click()}>
                <Upload />
                安装 .pim 插件包
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <input
          ref={fileInput}
          hidden
          type="file"
          accept=".pim"
          aria-label="安装插件包"
          disabled={Boolean(busy)}
          onChange={(event) => {
            void upload(event.target.files?.[0])
            event.target.value = ''
          }}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex gap-1" aria-label="插件状态">
          {(['all', 'enabled', 'disabled'] as const).map((value) => (
            <Button
              key={value}
              variant={filter === value ? 'secondary' : 'ghost'}
              className="rounded-full"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {value === 'all' ? '全部' : value === 'enabled' ? '已启用' : '已停用'}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{filtered.length} 个插件</p>
      </div>
      {error && (
        <p role="alert" className="rounded-xl bg-destructive/10 p-4 text-sm text-destructive break-words">
          {error}
        </p>
      )}
      <ul
        aria-label="已安装插件"
        className="grid grid-cols-1 gap-x-8 gap-y-2 border-t border-border pt-4 lg:grid-cols-2"
      >
        {filtered.map((plugin) => {
          const item = presentation(plugin)
          const Icon = item.icon
          return (
            <li
              key={plugin.id}
              className="flex min-w-0 items-center gap-1 rounded-2xl pr-2 transition-colors hover:bg-secondary/50"
            >
              <button
                type="button"
                onClick={() => setSelected(plugin.id)}
                aria-label={`查看插件：${plugin.id}`}
                className="flex min-h-24 min-w-0 flex-1 items-center gap-4 rounded-2xl p-3 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-card text-primary">
                  <Icon className="size-6" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {item.name}
                    <span className="ml-2 text-xs font-normal text-muted-foreground">{plugin.version}</span>
                  </span>
                  <span className="mt-1 line-clamp-2 break-words text-sm leading-6 text-muted-foreground">
                    {item.description}
                  </span>
                  <span
                    className={cn(
                      'mt-1 block text-xs text-muted-foreground',
                      (plugin.error || errors[plugin.id] || plugin.status === 'failed') && 'text-destructive',
                    )}
                  >
                    {busy === plugin.id
                      ? '正在处理…'
                      : errors[plugin.id]
                        ? 'UI 加载失败'
                        : plugin.error
                          ? '加载失败'
                          : statusNames[plugin.status]}
                  </span>
                </span>
              </button>
              {menu(plugin)}
            </li>
          )
        })}
      </ul>
      {!filtered.length && (
        <p role="status" className="py-10 text-center text-sm text-muted-foreground">
          {plugins.length ? '没有匹配的插件。' : '没有已安装的插件。'}
        </p>
      )}
      <Dialog
        open={directoryOpen}
        onOpenChange={(open) => {
          if (!busy) setDirectoryOpen(open)
        }}
      >
        <DialogContent>
          <DialogTitle>加载 Host 插件目录</DialogTitle>
          <DialogDescription>填写当前 Host 上已构建的插件目录。目录内容会复制为独立快照。</DialogDescription>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              void action('install', () => client.installDirectory(path.trim())).then((ok) => {
                if (ok) {
                  setDirectoryOpen(false)
                  setPath('')
                }
              })
            }}
          >
            <Input
              aria-label="插件在 Host 上的目录"
              placeholder="Host 上的插件目录"
              value={path}
              onChange={(event) => setPath(event.target.value)}
              disabled={Boolean(busy)}
            />
            {error && (
              <p role="alert" className="text-sm text-destructive break-words">
                {error}
              </p>
            )}
            <div className="flex justify-end">
              <Button type="submit" disabled={Boolean(busy) || !path.trim()}>
                {busy ? '正在加载…' : '加载目录'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(detail)}
        onOpenChange={(open) => {
          if (!open) setSelected(null)
        }}
      >
        <DialogContent>
          {detail && (
            <>
              <DialogTitle>{presentation(detail).name}</DialogTitle>
              <DialogDescription>{presentation(detail).description}</DialogDescription>
              <div className="space-y-4 overflow-y-auto text-sm select-text">
                <dl className="space-y-3">
                  <div>
                    <dt className="text-xs text-muted-foreground">包名</dt>
                    <dd className="mt-1 break-all font-mono text-xs">{detail.id}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">版本与状态</dt>
                    <dd className="mt-1">
                      {detail.version} · {errors[detail.id] ? 'UI 加载失败' : statusNames[detail.status]}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">来源</dt>
                    <dd className="mt-1">已安装插件</dd>
                  </div>
                </dl>
                {(detail.error || errors[detail.id]) && (
                  <p role="alert" className="whitespace-pre-wrap break-words text-destructive">
                    {detail.error || errors[detail.id]}
                  </p>
                )}
                {error && (
                  <p role="alert" className="text-destructive break-words">
                    {error}
                  </p>
                )}
              </div>
              {renderSettings?.(detail.id)}
              <div className="flex justify-end">{menu(detail)}</div>
            </>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(removing)}
        onOpenChange={(open) => {
          if (!open) setRemoving(null)
        }}
      >
        <DialogContent>
          <DialogTitle>卸载插件？</DialogTitle>
          <DialogDescription>
            {removing} 的插件数据和 Pi 会话会保留。必需服务仍被其他插件使用时，Host 会拒绝卸载。
          </DialogDescription>
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={Boolean(busy)} onClick={() => setRemoving(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={Boolean(busy)}
              onClick={() => {
                if (removing)
                  void action(removing, () => client.remove(removing)).then((ok) => {
                    if (ok) {
                      setRemoving(null)
                      setSelected(null)
                    }
                  })
              }}
            >
              卸载
            </Button>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive break-words">
              {error}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
