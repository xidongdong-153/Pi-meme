import { useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, Puzzle, RefreshCw, Upload, PanelRight, ChevronDown, Plus } from 'lucide-react'
import type { PluginClient } from '@pi-meme/client/plugin-client'
import type { UiPluginDescriptor } from '@pi-meme/plugin-sdk/ui'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Switch } from '@pi-meme/ui/components/ui/switch'
import { IntegrationHeader } from '@pi-meme/ui/components/integration-header'
import { systemPlugins } from '@pi-meme/plugin-sdk/system-plugins'
import { isReservedPluginId } from '@pi-meme/plugin-sdk/reserved'
import { cn } from '@pi-meme/ui/lib/utils'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@pi-meme/ui/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@pi-meme/ui/components/ui/dropdown-menu'
import { CategoryTabs } from './category-tabs'

const statusNames = { active: '已启用', disabled: '已停用', pending: '等待使用中的任务结束', failed: '加载失败' }
const systemPluginIcons: Record<string, string> = {
  '@pi-meme/git': new URL('./assets/plugins/git.png', import.meta.url).href,
  '@pi-meme/file-directory': new URL('./assets/plugins/file-directory.png', import.meta.url).href,
  '@pi-meme/terminal': new URL('./assets/plugins/terminal.png', import.meta.url).href,
}

export function PluginPage({
  client,
  plugins,
  errors,
  onChanged,
  renderSettings,
  onOpenSystem,
  onCreate,
}: {
  client: PluginClient
  plugins: UiPluginDescriptor[]
  errors: Record<string, string>
  onChanged: () => Promise<void>
  renderSettings?: (id: string) => ReactNode
  onOpenSystem?: (id: string) => void
  onCreate?: () => boolean
}) {
  const [category, setCategory] = useState<'personal' | 'system'>('personal')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [removing, setRemoving] = useState<UiPluginDescriptor>()
  const [installResult, setInstallResult] = useState('')
  const uploadRef = useRef<HTMLInputElement>(null)
  const installed = plugins.filter((plugin) => !plugin.builtin && !isReservedPluginId(plugin.id))
  const catalog = [...installed, ...systemPlugins]
  const detail = catalog.find((plugin) => plugin.id === selected)
  const filtered = (category === 'system' ? systemPlugins : installed).filter((plugin) =>
    `${plugin.id} ${plugin.display?.name ?? ''} ${plugin.description ?? ''}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  )

  async function refresh() {
    if (refreshing || busy) return
    setRefreshing(true)
    setError('')
    const start = Date.now()
    try {
      await onChanged()
    } catch (cause) {
      setError(String(cause))
    } finally {
      const elapsed = Date.now() - start
      if (elapsed < 400) {
        await new Promise((resolve) => setTimeout(resolve, 400 - elapsed))
      }
      setRefreshing(false)
    }
  }

  async function action(work: () => Promise<unknown>) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await work()
      if (work !== onChanged) await onChanged()
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }
  async function install(file: File) {
    await action(async () => {
      if (!file.name.endsWith('.pim')) throw new Error('请选择 .pim 插件包')
      if (file.size > 32 * 1024 * 1024) throw new Error('插件包不能超过 32 MiB')
      const bytes = new Uint8Array(await file.arrayBuffer())
      const chunks: string[] = []
      for (let offset = 0; offset < bytes.length; offset += 32768)
        chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)))
      await client.installPackage(btoa(chunks.join('')))
      setInstallResult('插件包已安装；同包名的新版本会更新已有插件。')
    })
  }
  const installButton = (
    <Button
      variant="outline"
      disabled={busy}
      onClick={() => {
        setInstallResult('')
        uploadRef.current?.click()
      }}
    >
      <Upload />
      {detail ? '更新插件包' : '安装插件包'}
    </Button>
  )
  return (
    <section aria-label="插件管理" className="space-y-6" aria-busy={busy}>
      <input
        hidden
        ref={uploadRef}
        type="file"
        accept=".pim"
        aria-label="选择 App 插件包"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) void install(file)
        }}
      />
      {error && (
        <p role="alert" className="break-words text-sm text-destructive">
          {error}
        </p>
      )}
      {installResult && (
        <p role="status" className="text-sm text-muted-foreground">
          {installResult}
        </p>
      )}
      {detail ? (
        <>
          <Button variant="ghost" onClick={() => setSelected(undefined)}>
            <ArrowLeft />
            返回插件
          </Button>
          <div className="flex items-center gap-3">
            <PluginIcon plugin={detail} />
            <div>
              <h3 className="text-xl font-semibold">{detail.display?.name ?? detail.id}</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {detail.version} · {statusNames[detail.status]}
              </p>
            </div>
          </div>
          <p className="whitespace-pre-wrap text-sm leading-7">{detail.description || '未提供说明'}</p>
          <dl className="space-y-3 rounded-xl border border-border p-4 text-sm">
            <div>
              <dt className="text-muted-foreground">包名</dt>
              <dd className="mt-1 break-all font-mono text-xs">{detail.id}</dd>
            </div>
          </dl>
          <PluginCapabilities plugin={detail} />
          {(detail.error || errors[detail.id]) && (
            <p role="alert" className="whitespace-pre-wrap break-words text-sm text-destructive">
              {detail.error || errors[detail.id]}
            </p>
          )}
          {detail.builtin ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">随应用提供，始终启用。可在当前会话右侧栏打开。</p>
              <Button variant="outline" disabled={!onOpenSystem} onClick={() => onOpenSystem?.(detail.id)}>
                <PanelRight />
                在聊天中打开
              </Button>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void action(() => (detail.enabled ? client.disable(detail.id) : client.enable(detail.id)))
                  }
                >
                  {detail.enabled ? '停用插件' : '启用插件'}
                </Button>
                {installButton}
                <Button variant="outline" disabled={busy} onClick={() => void action(() => client.reload(detail.id))}>
                  重新加载插件
                </Button>
                <Button variant="destructive" disabled={busy} onClick={() => setRemoving(detail)}>
                  卸载插件
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                更新时请选择相同包名的 .pim 文件；正在使用的旧代次会保留到任务结束。
              </p>
              {renderSettings?.(detail.id)}
            </>
          )}
        </>
      ) : (
        <>
          <IntegrationHeader
            title="插件"
            description="个人插件由你安装，系统插件是应用自带的工具。创建插件会打开聊天并调用 Plugin Creator。"
            query={query}
            onQuery={setQuery}
            searchLabel="搜索插件"
            actions={
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="刷新插件列表"
                  disabled={refreshing || busy}
                  onClick={() => void refresh()}
                >
                  <RefreshCw className={cn(refreshing && 'animate-spin')} />
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button aria-label="添加插件" disabled={busy}>
                      添加
                      <ChevronDown className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onSelect={() => {
                        if (!onCreate?.())
                          setError('系统技能 Plugin Creator 尚未进入当前会话。请刷新或开始聊天后再试。')
                      }}
                    >
                      <Plus />
                      创建插件
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => {
                        setInstallResult('')
                        uploadRef.current?.click()
                      }}
                    >
                      <Upload />
                      上传插件包
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            }
          >
            <CategoryTabs
              label="插件类别"
              idPrefix="plugin-category"
              value={category}
              onChange={setCategory}
              controls="plugin-list"
              options={[
                { id: 'personal', label: '个人', count: installed.length },
                { id: 'system', label: '系统', count: systemPlugins.length },
              ]}
            />
          </IntegrationHeader>
          <div id="plugin-list" role="tabpanel" aria-labelledby={`plugin-category-${category}`}>
            <ul aria-label="App 插件列表" className="space-y-1 pt-6">
              {filtered.map((plugin) => (
                <li key={plugin.id} className="flex min-h-24 items-center gap-4 rounded-xl px-3 hover:bg-secondary/30">
                  <button
                    type="button"
                    aria-label={`查看插件：${plugin.id}`}
                    onClick={() => {
                      setSelected(plugin.id)
                      setInstallResult('')
                    }}
                    className="flex min-w-0 flex-1 items-center gap-4 rounded-lg py-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <PluginIcon plugin={plugin} />
                    <span className="min-w-0">
                      <span className="block truncate text-base font-medium">{plugin.display?.name ?? plugin.id}</span>
                      <span className="mt-1 block truncate text-sm text-muted-foreground">
                        {plugin.description || '未提供说明'}
                      </span>
                    </span>
                  </button>
                  {plugin.builtin && (
                    <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">始终启用</span>
                  )}
                  <Switch
                    label={`${plugin.builtin ? '系统插件' : '启用插件'}：${plugin.display?.name ?? plugin.id}`}
                    checked={plugin.enabled}
                    disabled={busy || plugin.builtin || plugin.status === 'pending'}
                    onChange={(enabled) =>
                      void action(() => (enabled ? client.enable(plugin.id) : client.disable(plugin.id)))
                    }
                  />
                </li>
              ))}
            </ul>
            {!filtered.length && (
              <p role="status" className="py-8 text-center text-sm text-muted-foreground">
                {query ? '没有匹配的插件。' : category === 'system' ? '没有系统插件。' : '没有个人插件。'}
              </p>
            )}
          </div>
        </>
      )}
      <Dialog
        open={Boolean(removing)}
        onOpenChange={(open) => {
          if (!open) setRemoving(undefined)
        }}
      >
        <DialogContent>
          <DialogTitle>卸载插件？</DialogTitle>
          <DialogDescription>
            {removing?.display?.name ?? removing?.id} 的插件数据和已有会话保留；必需服务仍被其他插件使用时，应用
            会拒绝卸载。
          </DialogDescription>
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={busy} onClick={() => setRemoving(undefined)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() =>
                removing &&
                void action(async () => {
                  await client.remove(removing.id)
                  setRemoving(undefined)
                  setSelected(undefined)
                })
              }
            >
              卸载
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  )
}
function PluginIcon({ plugin }: { plugin: UiPluginDescriptor }) {
  const systemIcon = plugin.builtin ? systemPluginIcons[plugin.id] : undefined
  if (systemIcon)
    return <img aria-hidden alt="" src={systemIcon} className="size-12 shrink-0 object-contain" draggable={false} />
  return (
    <span className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-secondary/50 text-muted-foreground">
      {plugin.iconUrl ? (
        <img src={plugin.iconUrl} alt="" className="size-full object-contain" />
      ) : (
        <Puzzle className="size-6" strokeWidth={1.6} />
      )}
    </span>
  )
}
export function PluginCapabilities({ plugin }: { plugin: UiPluginDescriptor }) {
  const capabilities = plugin.capabilities
  return (
    <section aria-label="插件能力" className="space-y-3 rounded-xl border border-border p-4 text-sm">
      <h4 className="font-medium">插件能力</h4>
      <ul className="space-y-2 text-muted-foreground">
        {capabilities?.server && <li>后台服务：在所属设备上运行。</li>}
        {capabilities?.agent && (
          <li>Agent 工具与消息：在聊天输入区逐会话选择；运行中不能修改。安装或启用插件不会自动加入当前聊天。</li>
        )}
        {capabilities?.ui && <li>界面：从聊天右侧栏的“＋”工具页打开面板。</li>}
        {capabilities?.resources && (
          <li>包内资源：附带的技能在技能页管理调用策略，主题在外观设置中选择。包内文件随插件一起更新和卸载。</li>
        )}
        {!capabilities && <li>所属设备未提供能力说明。</li>}
      </ul>
    </section>
  )
}
