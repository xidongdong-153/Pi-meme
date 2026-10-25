import { useId, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, Check, Puzzle, RefreshCw, Settings, Upload, PanelRight, ChevronDown, Plus } from 'lucide-react'
import { systemPluginIcons } from '@pi-meme/assets/builtin'
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
import { PluginPermissions } from './plugin-permissions'

const statusNames = { active: '已启用', disabled: '已停用', pending: '等待使用中的任务结束', failed: '加载失败' }

export function PluginPage({
  client,
  plugins,
  errors,
  onChanged,
  renderSettings,
  onOpenSystem,
  onCreate,
  view = 'settings',
  selection,
  onSettings,
}: {
  client: PluginClient
  plugins: UiPluginDescriptor[]
  errors: Record<string, string>
  onChanged: () => Promise<void>
  renderSettings?: (id: string) => ReactNode
  onOpenSystem?: (id: string) => void
  onCreate?: () => boolean | Promise<boolean>
  view?: 'settings' | 'catalog'
  selection?: { id?: string; onChange: (id?: string) => void }
  onSettings?: () => void
}) {
  const listId = useId()
  const [category, setCategory] = useState<'personal' | 'system'>('personal')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [removing, setRemoving] = useState<UiPluginDescriptor>()
  const [installResult, setInstallResult] = useState('')
  const [savedGrant, setSavedGrant] = useState<{ id: string; policyHash?: string; revision: number }>()
  const editedGrant = useRef<typeof savedGrant>(undefined)
  const uploadRef = useRef<HTMLInputElement>(null)
  const installed = plugins.filter((plugin) => !plugin.builtin && !isReservedPluginId(plugin.id))
  const catalog = [...installed, ...systemPlugins]
  const detail = catalog.find((plugin) => plugin.id === (selection ? selection.id : selected))
  const filtered = (category === 'system' ? systemPlugins : installed).filter((plugin) =>
    `${plugin.id} ${plugin.display?.name ?? ''} ${plugin.description ?? ''}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  )

  function select(id?: string) {
    if (selection) selection.onChange(id)
    else setSelected(id)
  }

  async function create() {
    if (creating) return
    setCreating(true)
    setError('')
    try {
      if (!(await onCreate?.())) setError('无法调用系统技能 Plugin Creator，请刷新插件或技能后再试。')
    } catch (cause) {
      setError(`无法创建插件会话：${String(cause)}`)
    } finally {
      setCreating(false)
    }
  }

  const settingsButton = onSettings && (
    <Button variant="ghost" size="icon" aria-label="插件设置" title="插件设置" onClick={onSettings}>
      <Settings />
    </Button>
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
          <div className="flex items-center justify-between">
            <Button variant="ghost" onClick={() => select(undefined)}>
              <ArrowLeft />
              返回插件
            </Button>
            {settingsButton}
          </div>
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
              {detail.policyHash && (
                <PluginPermissions
                  key={`${detail.id}:${detail.policyHash}:${detail.grant?.revision ?? 0}`}
                  plugin={detail}
                  client={client}
                  onChanged={onChanged}
                  onSaved={(updated) => {
                    const grant = updated.grant
                    const edited = editedGrant.current
                    // 列表可能先于保存响应更新；该修订已有新编辑时，不恢复旧成功提示。
                    if (
                      grant &&
                      edited?.id === updated.id &&
                      edited.policyHash === updated.policyHash &&
                      edited.revision >= grant.revision
                    )
                      return
                    setSavedGrant(
                      grant ? { id: updated.id, policyHash: updated.policyHash, revision: grant.revision } : undefined,
                    )
                  }}
                  onEdit={() => {
                    editedGrant.current = {
                      id: detail.id,
                      policyHash: detail.policyHash,
                      revision: detail.grant?.revision ?? 0,
                    }
                    setSavedGrant(undefined)
                  }}
                />
              )}
              {savedGrant?.id === detail.id &&
                savedGrant.policyHash === detail.policyHash &&
                savedGrant.revision === detail.grant?.revision && (
                  <p role="status" className="text-xs text-muted-foreground">
                    权限已保存。
                  </p>
                )}
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
            query={query}
            onQuery={setQuery}
            searchLabel="搜索插件"
            title={view === 'catalog' ? '插件' : undefined}
            description={view === 'catalog' ? '查看已安装的插件，扩展聊天中的工具与功能。' : undefined}
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
                {settingsButton}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button aria-label="添加插件" disabled={busy || creating} className="rounded-full">
                      添加
                      <ChevronDown className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="bottom" align="end">
                    <DropdownMenuItem onSelect={() => void create()}>
                      <Plus />
                      创建插件
                    </DropdownMenuItem>
                    {view === 'settings' && (
                      <DropdownMenuItem
                        onSelect={() => {
                          setInstallResult('')
                          uploadRef.current?.click()
                        }}
                      >
                        <Upload />
                        上传插件包
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            }
          >
            {view === 'catalog' ? (
              <h2 className="text-sm font-medium">
                已安装 <span className="ml-2 text-muted-foreground">{installed.length}</span>
              </h2>
            ) : (
              <CategoryTabs
                label="插件类别"
                idPrefix={`${listId}-category`}
                value={category}
                onChange={setCategory}
                controls={listId}
                options={[
                  { id: 'personal', label: '个人', count: installed.length },
                  { id: 'system', label: '系统', count: systemPlugins.length },
                ]}
              />
            )}
          </IntegrationHeader>
          <div
            id={listId}
            role={view === 'settings' ? 'tabpanel' : undefined}
            aria-labelledby={view === 'settings' ? `${listId}-category-${category}` : undefined}
          >
            {filtered.length > 0 && (
              <ul
                aria-label="App 插件列表"
                className={
                  view === 'catalog'
                    ? 'grid grid-cols-1 gap-x-6 gap-y-2 xl:grid-cols-2'
                    : 'divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card'
                }
              >
                {filtered.map((plugin) => (
                  <li
                    key={plugin.id}
                    className={cn(
                      'flex items-center gap-4',
                      view === 'catalog' ? 'rounded-2xl p-3 transition-colors hover:bg-secondary/60' : 'p-5',
                    )}
                  >
                    <button
                      type="button"
                      aria-label={`查看插件：${plugin.id}`}
                      onClick={() => {
                        select(plugin.id)
                        setInstallResult('')
                      }}
                      className="flex min-w-0 flex-1 items-center gap-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <PluginIcon plugin={plugin} compact={view === 'settings'} />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{plugin.display?.name ?? plugin.id}</span>
                        <span className="mt-1 block truncate text-sm text-muted-foreground">
                          {plugin.description || '未提供说明'}
                        </span>
                      </span>
                    </button>
                    {plugin.builtin && (
                      <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">始终启用</span>
                    )}
                    {view === 'catalog' ? (
                      <span className="shrink-0 text-xs text-muted-foreground" title={statusNames[plugin.status]}>
                        {plugin.enabled && plugin.status === 'active' ? (
                          <Check aria-label="已启用" className="size-4" />
                        ) : (
                          statusNames[plugin.status]
                        )}
                      </span>
                    ) : (
                      <Switch
                        label={`${plugin.builtin ? '系统插件' : '启用插件'}：${plugin.display?.name ?? plugin.id}`}
                        checked={plugin.enabled}
                        disabled={busy || plugin.builtin || plugin.status === 'pending'}
                        onChange={(enabled) =>
                          void action(() => (enabled ? client.enable(plugin.id) : client.disable(plugin.id)))
                        }
                      />
                    )}
                  </li>
                ))}
              </ul>
            )}
            {!filtered.length && (
              <p role="status" className="text-sm text-muted-foreground">
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
                  select(undefined)
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
export function PluginIcon({
  plugin,
  compact = false,
  className,
}: {
  plugin: UiPluginDescriptor
  compact?: boolean
  className?: string
}) {
  const systemIcon = plugin.builtin ? systemPluginIcons[plugin.id] : undefined
  const box = compact ? 'size-8' : 'size-12'
  if (systemIcon)
    return (
      <img
        aria-hidden
        alt=""
        src={systemIcon}
        className={cn(box, 'shrink-0 object-contain', className)}
        draggable={false}
      />
    )
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden rounded-xl bg-secondary/50 text-muted-foreground',
        box,
        className,
      )}
    >
      {plugin.iconUrl ? (
        <img src={plugin.iconUrl} alt="" className="size-full object-contain" />
      ) : (
        <Puzzle className={compact ? 'size-4' : 'size-6'} strokeWidth={1.6} />
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
        {capabilities?.ui && <li>界面：业务页面从左侧插件图标进入；工具面板仍从聊天右侧栏的“＋”打开。</li>}
        {capabilities?.resources && (
          <li>包内资源：附带的技能在技能页管理调用策略，主题在外观设置中选择。包内文件随插件一起更新和卸载。</li>
        )}
        {!capabilities && <li>所属设备未提供能力说明。</li>}
      </ul>
    </section>
  )
}
