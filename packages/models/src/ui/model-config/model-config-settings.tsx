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
import { Badge } from '@pi-meme/ui/components/ui/badge'
import { Button } from '@pi-meme/ui/components/ui/button'
import { SettingsCard, SettingsRow, settingsControlClassName } from '@pi-meme/ui/components/settings'
import { BrandMark } from '@pi-meme/ui/components/brand-mark'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@pi-meme/ui/components/ui/dialog'
import { OverflowTooltip, TooltipHint, TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'
import { Code2, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { cn } from '@pi-meme/ui/lib/utils'
import { CrossfadeText } from '@pi-meme/ui/components/crossfade-text'
import { BuiltinProviders } from '../builtin-providers'
import { ModelConfigForm } from './model-config-form'
import { ModelSelect } from '../model-select'
import { THINKING_LEVEL_LABELS } from '../thinking-config'

const shortApiLabels: Record<ModelApi, string> = {
  'openai-completions': 'OpenAI',
  'openai-responses': 'Responses',
  'anthropic-messages': 'Anthropic',
  'google-generative-ai': 'Gemini',
}

export function ModelConfigSettings({
  mobile = false,
  busy,
  bridge,
  models,
}: {
  mobile?: boolean
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
  const [defaultLoading, setDefaultLoading] = useState(true)
  const [defaultError, setDefaultError] = useState('')
  const [thinkingLoading, setThinkingLoading] = useState(true)
  const [thinkingError, setThinkingError] = useState('')
  const [defaultThinking, setDefaultThinking] = useState<ThinkingLevel | null>(null)
  const [thinkingSaving, setThinkingSaving] = useState(false)
  const [editing, setEditing] = useState<{ target: ConfiguredProvider | 'new'; mode: 'form' | 'json' } | null>(null)
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
        setError(String(cause))
      }
    } finally {
      lock.current = false
      if (active.current) setLoading(false)
    }
  }

  async function loadDefault() {
    setDefaultLoading(true)
    setDefaultError('')
    try {
      const model = await bridge.getDefaultModel()
      if (active.current) setDefaultModel(model)
    } catch (cause) {
      if (active.current) setDefaultError(String(cause))
    } finally {
      if (active.current) setDefaultLoading(false)
    }
  }

  async function loadThinking() {
    setThinkingLoading(true)
    setThinkingError('')
    try {
      const level = await bridge.getDefaultThinkingLevel()
      if (active.current) setDefaultThinking(level)
    } catch (cause) {
      if (active.current) setThinkingError(String(cause))
    } finally {
      if (active.current) setThinkingLoading(false)
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
  const thinkingDisabled =
    busy || saving || defaultSaving || thinkingSaving || thinkingLoading || Boolean(thinkingError)
  const activeThinking = defaultThinking ?? 'medium'

  return (
    <TooltipProvider delayDuration={150}>
      <div className="space-y-6">
        <SettingsCard>
          <SettingsRow className="[&>div]:max-w-full [&_[role=combobox]]:min-w-0 [&_[role=combobox]]:max-w-full">
            <h3 className="whitespace-nowrap font-medium">默认模型</h3>
            <ModelSelect
              models={models}
              current={defaultModel ?? undefined}
              disabled={busy || saving || defaultSaving || thinkingSaving || defaultLoading || Boolean(defaultError)}
              displayText={
                defaultLoading
                  ? '读取中…'
                  : defaultError
                    ? '读取失败'
                    : defaultModel
                      ? `${defaultModel.provider} / ${defaultModel.name ?? defaultModel.id}`
                      : '自动选择'
              }
              onSelect={(model) => void selectDefault(model)}
            />
          </SettingsRow>
          <SettingsRow className="gap-y-2.5">
            <h3 className="whitespace-nowrap font-medium">思考强度默认值</h3>
            {thinkingLoading || thinkingError ? (
              <span className="whitespace-nowrap text-[11px] text-muted-foreground">
                {thinkingLoading ? '读取中…' : '读取失败'}
              </span>
            ) : (
              <div
                role="radiogroup"
                aria-label="思考强度默认值"
                className="inline-flex max-w-full flex-wrap gap-0.5 rounded-lg bg-secondary/50 p-0.5"
              >
                {thinkingLevels.map((level) => {
                  const selected = activeThinking === level
                  return (
                    <button
                      key={level}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      disabled={thinkingDisabled}
                      onClick={() => void selectThinking(level)}
                      className={cn(
                        'whitespace-nowrap rounded-md px-2.5 py-1 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50',
                        selected
                          ? 'bg-card font-medium text-foreground shadow-xs'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {THINKING_LEVEL_LABELS[level]}
                    </button>
                  )
                })}
              </div>
            )}
          </SettingsRow>
        </SettingsCard>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div
            role="tablist"
            aria-label="模型服务商类型"
            className={cn(
              'gap-1 rounded-lg bg-secondary/50 p-1',
              mobile ? 'grid w-full grid-cols-2 rounded-full' : 'inline-flex',
            )}
          >
            {(
              [
                { id: 'builtin', label: '内置提供商', count: undefined },
                { id: 'custom', label: '自定义提供商', count: snapshot?.providers.length },
              ] as const
            ).map(({ id, label, count }) => (
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
                  'whitespace-nowrap px-3 text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                  mobile ? 'h-9 rounded-full text-sm' : 'rounded-md py-1.5 text-xs',
                  providerTab === id && 'bg-card font-medium text-foreground shadow-xs',
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
                {count !== undefined && <span className="ml-1.5 text-[10px] opacity-70 tabular-nums">{count}</span>}
              </button>
            ))}
          </div>

          {providerTab === 'custom' && (
            <div className="flex shrink-0 items-center gap-1.5">
              <TooltipHint content="刷新配置">
                <Button
                  size="icon"
                  variant="outline"
                  aria-label="刷新配置"
                  className="size-8 rounded-lg shadow-none"
                  disabled={loading || saving}
                  onClick={() => void load()}
                >
                  <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
                </Button>
              </TooltipHint>
              <Button
                className={cn(settingsControlClassName, 'whitespace-nowrap')}
                disabled={!snapshot || loading || saving}
                onClick={() => setEditing({ target: 'new', mode: 'form' })}
              >
                <Plus className="mr-1 size-3.5" />
                添加服务商
              </Button>
            </div>
          )}
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
          aria-busy={loading}
        >
          {loading && !snapshot && (
            <p role="status" className="px-1 text-[11px] text-muted-foreground">
              正在读取自定义服务商…
            </p>
          )}
          {snapshot && (
            <SettingsCard className="ui-text-enter">
              {!snapshot.providers.length && (
                <div className="space-y-3 px-4 py-8 text-center">
                  <div className="space-y-1">
                    <p className="font-medium">尚未配置自定义服务商</p>
                    <p className="text-[11px] text-muted-foreground">
                      接入 OpenAI 兼容中转、Anthropic、Gemini 或本地 Ollama 接口。
                    </p>
                  </div>
                  <Button
                    className={cn(settingsControlClassName, 'whitespace-nowrap')}
                    size="sm"
                    disabled={loading || saving}
                    onClick={() => setEditing({ target: 'new', mode: 'form' })}
                  >
                    <Plus className="mr-1 size-3.5" />
                    添加服务商
                  </Button>
                </div>
              )}
              {snapshot.providers.map((provider) => {
                const editable = modelApis.includes(provider.api as ModelApi)
                const apiBadge = shortApiLabels[provider.api as ModelApi] ?? (provider.api || '继承协议')
                return (
                  <SettingsRow key={provider.id} className="gap-y-2.5">
                    <div className="flex min-w-0 flex-1 basis-52 items-start gap-2.5">
                      <span
                        aria-hidden="true"
                        className={cn(
                          'mt-1.5 size-2 shrink-0 rounded-full',
                          provider.hasApiKey ? 'bg-emerald-500' : 'bg-amber-500/70',
                        )}
                      />
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <h3 className="whitespace-nowrap font-medium">
                            <CrossfadeText>{provider.name}</CrossfadeText>
                          </h3>
                          {provider.id !== provider.name && (
                            <span className="truncate font-mono text-[11px] text-muted-foreground">{provider.id}</span>
                          )}
                          <Badge variant="secondary" className="h-4.5 whitespace-nowrap px-1.5 text-[10px] font-normal">
                            {apiBadge}
                          </Badge>
                          <Badge
                            variant="outline"
                            className="h-4.5 whitespace-nowrap px-1.5 text-[10px] font-normal tabular-nums"
                          >
                            {provider.models.length} 个模型
                          </Badge>
                          {!provider.hasApiKey && (
                            <span className="whitespace-nowrap text-[11px] text-amber-600 dark:text-amber-400">
                              未配 Key
                            </span>
                          )}
                        </div>
                        <div className="min-w-0 text-[11px] text-muted-foreground">
                          <OverflowTooltip content={provider.baseUrl || '使用服务默认地址'}>
                            <span className="block truncate font-mono">{provider.baseUrl || '使用服务默认地址'}</span>
                          </OverflowTooltip>
                        </div>
                        {!editable && (
                          <p className="text-[11px] text-muted-foreground">
                            此配置使用继承协议或其他协议，请在配置文件中编辑。
                          </p>
                        )}
                      </div>
                    </div>
                    <div
                      className={cn(
                        'flex shrink-0 flex-nowrap items-center gap-1.5',
                        mobile && 'w-full justify-end pt-1',
                      )}
                    >
                      <Button
                        className={cn(settingsControlClassName, 'whitespace-nowrap')}
                        size="sm"
                        variant="outline"
                        disabled={saving || !editable}
                        onClick={() => setEditing({ target: provider, mode: 'form' })}
                      >
                        编辑
                      </Button>
                      <TooltipHint content="以 JSON 编辑">
                        <Button
                          className={cn(
                            'shrink-0 rounded-lg text-muted-foreground hover:text-foreground',
                            mobile ? 'size-9 rounded-full' : 'size-8',
                          )}
                          size="icon"
                          variant="ghost"
                          aria-label={`以 JSON 编辑 ${provider.name}`}
                          disabled={saving || !editable}
                          onClick={() => setEditing({ target: provider, mode: 'json' })}
                        >
                          <Code2 className="size-4" />
                        </Button>
                      </TooltipHint>
                      <TooltipHint content="删除服务商">
                        <Button
                          className={cn(
                            'shrink-0 rounded-lg text-muted-foreground hover:text-destructive',
                            mobile ? 'size-9 rounded-full' : 'size-8',
                          )}
                          size="icon"
                          variant="ghost"
                          aria-label={`删除 ${provider.name}`}
                          disabled={busy || saving}
                          onClick={() => setDeleting(provider)}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </TooltipHint>
                    </div>
                  </SettingsRow>
                )
              })}
            </SettingsCard>
          )}
        </div>

        {(defaultError || thinkingError) && (
          <div role="alert" className="space-y-2 rounded-lg bg-destructive/10 p-3 text-xs text-destructive">
            <p>{defaultError || thinkingError}</p>
            <Button
              className={settingsControlClassName}
              variant="outline"
              disabled={defaultLoading || thinkingLoading}
              onClick={() => {
                if (defaultError) void loadDefault()
                if (thinkingError) void loadThinking()
              }}
            >
              重试读取默认值
            </Button>
          </div>
        )}
        {error && (
          <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-xs text-destructive">
            {error}
          </p>
        )}
        {reconnectError && (
          <div role="alert" className="space-y-2 rounded-lg bg-destructive/10 p-3">
            <p className="text-xs text-destructive">{reconnectError}</p>
            <Button
              className={settingsControlClassName}
              variant="outline"
              disabled={saving || busy}
              onClick={() => void reconnect()}
            >
              重新连接
            </Button>
          </div>
        )}

        {editing && snapshot && (
          <ModelConfigForm
            provider={editing.target === 'new' ? undefined : editing.target}
            initialMode={editing.mode}
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
              <DialogDescription>将删除此服务商的模型配置和安全凭据，操作不可恢复。</DialogDescription>
              <div className="flex justify-end gap-2">
                <Button
                  className={settingsControlClassName}
                  variant="outline"
                  disabled={saving}
                  onClick={() => setDeleting(null)}
                >
                  取消
                </Button>
                <Button
                  className={settingsControlClassName}
                  variant="destructive"
                  disabled={busy || saving}
                  onClick={() => void remove()}
                >
                  {saving ? '正在删除…' : '确认删除'}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        )}
      </div>
    </TooltipProvider>
  )
}
