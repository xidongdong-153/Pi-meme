import { useEffect, useId, useRef, useState } from 'react'
import type {
  ConfiguredProvider,
  ModelApi,
  ModelConfigResult,
  ModelConfigSnapshot,
  SaveModelProvider,
} from '@pi-meme/contracts/model-config'
import { modelApis } from '@pi-meme/contracts/model-config'
import { thinkingLevels, type PiModel, type ThinkingLevel } from '@pi-meme/contracts/pi'
import type { ModelsBridge } from '@pi-meme/contracts/desktop'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pi-meme/ui/components/ui/select'
import { BrandMark } from '@pi-meme/ui/components/brand-mark'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@pi-meme/ui/components/ui/dialog'
import { RefreshCw } from 'lucide-react'
import { cn } from '@pi-meme/ui/lib/utils'
import { BentoSkeletonBar, BentoSkeletonCard } from '@pi-meme/ui/components/bento-skeleton'
import { BuiltinProviders } from '../builtin-providers'
import { apiLabels, ModelConfigForm } from './model-config-form'
import { ModelSelect } from '../model-select'
import { THINKING_LEVEL_LABELS } from '../thinking-config'

export function ModelConfigSettings({
  busy,
  bridge,
  models,
}: {
  busy: boolean
  bridge: ModelsBridge
  models: PiModel[]
}) {
  const [snapshot, setSnapshot] = useState<ModelConfigSnapshot | null>(null)
  const [error, setError] = useState('')
  const [reconnectError, setReconnectError] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [defaultModel, setDefaultModel] = useState<PiModel | null>(null)
  const [defaultSaving, setDefaultSaving] = useState(false)
  const [defaultThinking, setDefaultThinking] = useState<ThinkingLevel | null>(null)
  const [thinkingSaving, setThinkingSaving] = useState(false)
  const [editing, setEditing] = useState<ConfiguredProvider | 'new' | null>(null)
  const [deleting, setDeleting] = useState<ConfiguredProvider | null>(null)
  const [providerTab, setProviderTab] = useState<'builtin' | 'custom'>('builtin')
  const tabsId = useId()
  const active = useRef(true)
  const lock = useRef(false)
  const defaultLock = useRef(false)
  const thinkingLock = useRef(false)
  async function load() {
    if (lock.current) return
    lock.current = true
    setLoading(true)
    setError('')
    try {
      const next = await bridge.getModelConfig()
      if (active.current) setSnapshot(next)
    } catch (cause) {
      if (active.current) {
        setSnapshot(null)
        setError(String(cause))
      }
    } finally {
      lock.current = false
      if (active.current) setLoading(false)
    }
  }
  async function loadDefault() {
    try {
      const model = await bridge.getDefaultModel()
      if (active.current) setDefaultModel(model)
    } catch (cause) {
      if (active.current) setError(String(cause))
    }
  }
  async function loadThinking() {
    try {
      const level = await bridge.getDefaultThinkingLevel()
      if (active.current) setDefaultThinking(level)
    } catch (cause) {
      if (active.current) setError(String(cause))
    }
  }
  async function selectThinking(level: ThinkingLevel) {
    if (thinkingLock.current || level === (defaultThinking ?? 'medium')) return
    thinkingLock.current = true
    setThinkingSaving(true)
    setError('')
    try {
      await bridge.setDefaultThinkingLevel(level)
      if (active.current) setDefaultThinking(level)
    } catch (cause) {
      if (active.current) setError(String(cause))
    } finally {
      thinkingLock.current = false
      if (active.current) setThinkingSaving(false)
    }
  }
  async function selectDefault(model: PiModel) {
    if (defaultLock.current) return
    defaultLock.current = true
    setDefaultSaving(true)
    setError('')
    try {
      await bridge.setDefaultModel(model)
      if (active.current) setDefaultModel(model)
    } catch (cause) {
      if (active.current) setError(String(cause))
    } finally {
      defaultLock.current = false
      if (active.current) setDefaultSaving(false)
    }
  }
  useEffect(() => {
    active.current = true
    void loadDefault()
    void loadThinking()
    return () => {
      active.current = false
    }
  }, [])
  useEffect(() => {
    if (editing || deleting || saving) return
    let current = true
    void bridge.getModelConfig().then(
      (value) => {
        if (current) {
          setSnapshot(value)
          setLoading(false)
        }
      },
      (cause: unknown) => {
        if (current) {
          setError(String(cause))
          setLoading(false)
        }
      },
    )
    return () => {
      current = false
    }
  }, [bridge, models, editing, deleting, saving])
  async function change(work: () => Promise<ModelConfigResult>) {
    if (lock.current) return false
    lock.current = true
    setSaving(true)
    setError('')
    try {
      const result = await work()
      setSnapshot(result.snapshot)
      setReconnectError(result.reconnectError ?? '')
      return true
    } catch (cause) {
      throw new Error(String(cause))
    } finally {
      lock.current = false
      setSaving(false)
    }
  }
  async function remove() {
    if (!deleting || !snapshot) return
    try {
      if (await change(() => bridge.deleteModelProvider(deleting.id, snapshot.revision))) setDeleting(null)
    } catch (cause) {
      setError(String(cause))
      setDeleting(null)
    }
  }
  async function reconnect() {
    if (lock.current) return
    lock.current = true
    setSaving(true)
    try {
      await bridge.reconnectModels()
      setReconnectError('')
    } catch (cause) {
      setReconnectError(String(cause))
    } finally {
      lock.current = false
      setSaving(false)
    }
  }
  const save = (input: SaveModelProvider) => change(() => bridge.saveModelProvider(input))
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-card p-5">
        <div className="min-w-0 space-y-1">
          <h3 className="font-medium">默认模型</h3>
          <p className="text-sm text-muted-foreground">新建会话默认使用的模型，不影响已打开的会话。</p>
        </div>
        <ModelSelect
          models={models}
          current={defaultModel ?? undefined}
          disabled={busy || saving || defaultSaving || thinkingSaving}
          placeholder="Pi 自动选择"
          onSelect={(model) => void selectDefault(model)}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-card p-5">
        <div className="min-w-0 space-y-1">
          <h3 className="font-medium">思考强度默认值</h3>
          <p className="text-sm text-muted-foreground">新建会话默认使用的思考强度，不影响已打开的会话。</p>
        </div>
        <Select
          value={defaultThinking ?? 'medium'}
          disabled={busy || saving || defaultSaving || thinkingSaving}
          onValueChange={(value) => {
            if ((thinkingLevels as readonly string[]).includes(value)) void selectThinking(value as ThinkingLevel)
          }}
        >
          <SelectTrigger
            aria-label="思考强度默认值"
            className="h-8 w-[140px] text-xs bg-secondary/50 border-border hover:bg-secondary/80 focus:outline-none"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {thinkingLevels.map((level) => (
              <SelectItem key={level} value={level} className="text-xs">
                {THINKING_LEVEL_LABELS[level]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div role="tablist" aria-label="模型服务商类型" className="inline-flex gap-1 rounded-lg bg-secondary/50 p-1">
        {(
          [
            { id: 'builtin', label: '内置提供商' },
            { id: 'custom', label: '自定义提供商' },
          ] as const
        ).map(({ id, label }) => (
          <button
            key={id}
            id={`${tabsId}-${id}`}
            type="button"
            role="tab"
            aria-selected={providerTab === id}
            aria-controls={`${tabsId}-${id}-panel`}
            tabIndex={providerTab === id ? 0 : -1}
            data-tab={id}
            className={cn(
              'rounded-md px-4 py-1.5 text-sm text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              providerTab === id && 'bg-secondary text-foreground',
            )}
            onClick={() => setProviderTab(id)}
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
              event.preventDefault()
              const next =
                event.key === 'Home'
                  ? 'builtin'
                  : event.key === 'End'
                    ? 'custom'
                    : providerTab === 'builtin'
                      ? 'custom'
                      : 'builtin'
              setProviderTab(next)
              event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus()
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        id={`${tabsId}-builtin-panel`}
        role="tabpanel"
        aria-labelledby={`${tabsId}-builtin`}
        hidden={providerTab !== 'builtin'}
      >
        <BuiltinProviders bridge={bridge} disabled={busy || saving || loading} />
      </div>
      <div
        id={`${tabsId}-custom-panel`}
        role="tabpanel"
        aria-labelledby={`${tabsId}-custom`}
        hidden={providerTab !== 'custom'}
        className="space-y-4"
      >
        <div className="flex flex-wrap justify-between gap-3">
          <p className="text-sm text-muted-foreground">管理自定义接口和 API Key，保存后自动重新连接 Pi。</p>
          <div className="flex gap-2">
            <Button variant="outline" disabled={loading || saving} onClick={() => void load()}>
              <RefreshCw className={cn('mr-1.5 size-3.5', loading && 'animate-spin')} />
              刷新配置
            </Button>
            <Button disabled={!snapshot || loading || saving} onClick={() => setEditing('new')}>
              添加服务商
            </Button>
          </div>
        </div>
        {!snapshot && loading && (
          <div className="space-y-3" data-testid="models-skeleton-providers">
            <BentoSkeletonCard delay={0}>
              <div className="flex items-center justify-between">
                <div className="space-y-1.5">
                  <BentoSkeletonBar className="w-32" size="sm" />
                  <BentoSkeletonBar className="w-48" size="xs" />
                </div>
                <BentoSkeletonBar className="h-8 w-24 rounded-lg" />
              </div>
            </BentoSkeletonCard>
            <BentoSkeletonCard delay={80}>
              <div className="flex items-center justify-between">
                <div className="space-y-1.5">
                  <BentoSkeletonBar className="w-28" size="sm" />
                  <BentoSkeletonBar className="w-40" size="xs" />
                </div>
                <BentoSkeletonBar className="h-8 w-24 rounded-lg" />
              </div>
            </BentoSkeletonCard>
          </div>
        )}
        {snapshot && (
          <>
            {!snapshot.providers.length && (
              <div className="rounded-xl border border-dashed border-border py-12 text-center space-y-2">
                <p className="font-medium">尚未配置自定义服务商</p>
                <p className="text-sm text-muted-foreground">添加接口、填写 API Key，再选择或添加模型。</p>
              </div>
            )}
            {snapshot.providers.map((provider) => (
              <div
                key={provider.id}
                className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-card p-5"
              >
                <div className="min-w-0 space-y-1">
                  <h3 className="font-medium">
                    {provider.name}
                    <span className="ml-2 font-mono text-xs text-muted-foreground">{provider.id}</span>
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {apiLabels[provider.api as ModelApi] ?? (provider.api || '继承 SDK 协议')} ·{' '}
                    {provider.models.length} 个模型 · {provider.hasApiKey ? '已配置 Key' : '未配置 Key'}
                  </p>
                  <p className="select-text break-all text-xs text-muted-foreground">
                    {provider.baseUrl || '使用服务默认地址'}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    disabled={saving || !modelApis.includes(provider.api as ModelApi)}
                    onClick={() => setEditing(provider)}
                  >
                    编辑
                  </Button>
                  <Button variant="ghost" disabled={busy || saving} onClick={() => setDeleting(provider)}>
                    删除
                  </Button>
                </div>
                {!modelApis.includes(provider.api as ModelApi) && (
                  <p className="w-full text-xs text-muted-foreground">
                    此配置使用继承协议或其他协议，请在配置文件中编辑。
                  </p>
                )}
              </div>
            ))}
          </>
        )}
      </div>
      {error && (
        <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      )}
      {reconnectError && (
        <div role="alert" className="rounded-lg bg-destructive/10 p-3 space-y-2">
          <p className="text-sm text-destructive">{reconnectError}</p>
          <Button variant="outline" disabled={saving || busy} onClick={() => void reconnect()}>
            重新连接
          </Button>
        </div>
      )}
      {editing && snapshot && (
        <ModelConfigForm
          provider={editing === 'new' ? undefined : editing}
          snapshot={snapshot}
          busy={busy}
          bridge={bridge}
          onSave={save}
          onClose={() => setEditing(null)}
        />
      )}
      {deleting && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !saving) setDeleting(null)
          }}
        >
          <DialogContent aria-label="删除模型服务商">
            <div className="flex items-center gap-2.5">
              <BrandMark size={28} />
              <DialogTitle>删除 {deleting.name}？</DialogTitle>
            </div>
            <DialogDescription>将删除 Desktop 应用数据目录中的此服务商模型配置和安全凭据。</DialogDescription>
            <div className="flex justify-end gap-2">
              <Button variant="outline" disabled={saving} onClick={() => setDeleting(null)}>
                取消
              </Button>
              <Button variant="destructive" disabled={busy || saving} onClick={() => void remove()}>
                {saving ? '正在删除…' : '确认删除'}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
