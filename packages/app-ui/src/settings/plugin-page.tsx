import { useId, useRef, useState, type ReactNode } from 'react'
import { TooltipHint } from '@pi-meme/ui/components/ui/tooltip'
import {
  ArrowLeft,
  Check,
  Circle,
  Plug,
  RefreshCw,
  Settings,
  Upload,
  PanelRight,
  ChevronDown,
  Plus,
} from 'lucide-react'
import { systemPluginIcons } from '@pi-meme/assets/builtin'
import type { PluginClient } from '@pi-meme/client/plugin-client'
import type { UiPluginDescriptor } from '@pi-meme/plugin-sdk/ui'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Switch } from '@pi-meme/ui/components/ui/switch'
import { CrossfadeText } from '@pi-meme/ui/components/crossfade-text'
import { SettingsCard, SettingsGroup, settingsControlClassName } from '@pi-meme/ui/components/settings'
import { ResourceSettingsHeader as IntegrationHeader } from './resource-settings-header'
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
    <TooltipHint content="插件设置">
      <Button
        className={settingsControlClassName}
        variant="ghost"
        size="icon"
        aria-label="插件设置"
        onClick={onSettings}
      >
        <Settings />
      </Button>
    </TooltipHint>
  )

  async function refresh() {
    if (refreshing || busy) return
    setRefreshing(true)
    setError('')
    try {
      await onChanged()
    } catch (cause) {
      setError(String(cause))
    } finally {
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
      className={settingsControlClassName}
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
    <section aria-label="插件管理" className="min-w-0 space-y-6" aria-busy={busy}>
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
        <p role="alert" className="break-words text-xs text-destructive">
          {error}
        </p>
      )}
      {installResult && (
        <p role="status" className="text-xs text-muted-foreground">
          {installResult}
        </p>
      )}
      {detail ? (
        <>
          <div className="flex items-center justify-between">
            <Button className={settingsControlClassName} variant="ghost" onClick={() => select(undefined)}>
              <ArrowLeft />
              返回插件
            </Button>
            {settingsButton}
          </div>
          <div className="flex min-w-0 items-center gap-3">
            <PluginIcon plugin={detail} compact={view === 'settings'} />
            <div className="min-w-0">
              <h3 className="min-w-0 break-words text-base font-semibold">{detail.display?.name ?? detail.id}</h3>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                <CrossfadeText>{`${detail.version} · ${statusNames[detail.status]}`}</CrossfadeText>
              </p>
            </div>
          </div>
          <p className="whitespace-pre-wrap text-xs leading-relaxed [overflow-wrap:anywhere]">
            {detail.description || '未提供说明'}
          </p>
          <SettingsCard>
            <dl className="px-4 py-3">
              <dt className="font-medium">包名</dt>
              <dd className="mt-0.5 break-all font-mono text-[11px] text-muted-foreground">{detail.id}</dd>
            </dl>
          </SettingsCard>
          <PluginCapabilities plugin={detail} />
          {(detail.error || errors[detail.id]) && (
            <p role="alert" className="whitespace-pre-wrap break-words text-xs text-destructive">
              {detail.error || errors[detail.id]}
            </p>
          )}
          {detail.builtin ? (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">随应用提供，始终启用。可在当前会话右侧栏打开。</p>
              <Button
                className={settingsControlClassName}
                variant="outline"
                disabled={!onOpenSystem}
                onClick={() => onOpenSystem?.(detail.id)}
              >
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
                  className={settingsControlClassName}
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void action(() => (detail.enabled ? client.disable(detail.id) : client.enable(detail.id)))
                  }
                >
                  <CrossfadeText reserve={['停用插件', '启用插件']}>
                    {detail.enabled ? '停用插件' : '启用插件'}
                  </CrossfadeText>
                </Button>
                {installButton}
                <Button
                  className={settingsControlClassName}
                  variant="outline"
                  disabled={busy}
                  onClick={() => void action(() => client.reload(detail.id))}
                >
                  重新加载插件
                </Button>
                <Button
                  className={settingsControlClassName}
                  variant="destructive"
                  disabled={busy}
                  onClick={() => setRemoving(detail)}
                >
                  卸载插件
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">选择此插件的新版 .pim 文件，运行中的任务不受影响。</p>
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
                  className={settingsControlClassName}
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
                    <Button aria-label="添加插件" disabled={busy || creating} className={settingsControlClassName}>
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
                已安装 <CrossfadeText className="ml-2 text-muted-foreground">{String(installed.length)}</CrossfadeText>
              </h2>
            ) : (
              <CategoryTabs
                label="插件类别"
                compact
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
                    : 'divide-y divide-border/40 overflow-hidden rounded-xl border border-border/70 bg-card/40'
                }
              >
                {filtered.map((plugin) => (
                  <li
                    key={plugin.id}
                    className={cn(
                      'flex min-w-0 items-center gap-3',
                      view === 'catalog'
                        ? 'rounded-2xl p-3 transition-colors hover:bg-secondary/60'
                        : 'px-4 py-3 text-xs',
                    )}
                  >
                    <button
                      type="button"
                      aria-label={`查看插件：${plugin.id}`}
                      onClick={() => {
                        select(plugin.id)
                        setInstallResult('')
                      }}
                      className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <PluginIcon plugin={plugin} compact={view === 'settings'} />
                      <span className="min-w-0">
                        <span className={cn('block truncate font-medium', view === 'catalog' ? 'text-sm' : 'text-xs')}>
                          {plugin.display?.name ?? plugin.id}
                        </span>
                        <span
                          className={cn(
                            'block truncate text-muted-foreground',
                            view === 'catalog' ? 'mt-1 text-sm' : 'mt-0.5 text-[11px]',
                          )}
                        >
                          {plugin.description || '未提供说明'}
                        </span>
                      </span>
                    </button>
                    {plugin.builtin && (
                      <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">始终启用</span>
                    )}
                    {view === 'catalog' ? (
                      <TooltipHint content={statusNames[plugin.status]}>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {plugin.enabled && plugin.status === 'active' ? (
                            <Check aria-label="已启用" className="size-4" />
                          ) : (
                            <CrossfadeText>{statusNames[plugin.status]}</CrossfadeText>
                          )}
                        </span>
                      </TooltipHint>
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
              <p role="status" className="text-xs text-muted-foreground">
                <CrossfadeText>
                  {query ? '没有匹配的插件。' : category === 'system' ? '没有系统插件。' : '没有个人插件。'}
                </CrossfadeText>
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
            <Button
              className={settingsControlClassName}
              variant="outline"
              disabled={busy}
              onClick={() => setRemoving(undefined)}
            >
              取消
            </Button>
            <Button
              className={settingsControlClassName}
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
        <span className={cn('relative', compact ? 'size-4' : 'size-6')} aria-hidden="true">
          <Circle className="size-full" strokeWidth={1.6} />
          <Plug className="absolute inset-[18.75%] size-[62.5%] -rotate-45" strokeWidth={1.6} />
        </span>
      )}
    </span>
  )
}
export function PluginCapabilities({ plugin }: { plugin: UiPluginDescriptor }) {
  const capabilities = plugin.capabilities
  return (
    <SettingsGroup title="插件能力">
      <SettingsCard>
        <ul className="space-y-2 px-4 py-3 text-[11px] leading-relaxed text-muted-foreground">
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
      </SettingsCard>
    </SettingsGroup>
  )
}
