import { useRef, useState } from 'react'
import type { ModelsBridge } from '@pi-meme/contracts/desktop'
import type {
  ConfiguredModel,
  ConfiguredProvider,
  ModelApi,
  ModelConfigSnapshot,
  SaveModelProvider,
} from '@pi-meme/contracts/model-config'
import { modelApis } from '@pi-meme/contracts/model-config'
import { thinkingLevels, type ThinkingLevel } from '@pi-meme/contracts/pi'
import { THINKING_LEVEL_LABELS } from '../thinking-config'
import { Button } from '@pi-meme/ui/components/ui/button'
import { settingsControlClassName } from '@pi-meme/ui/components/settings'
import { BrandMark } from '@pi-meme/ui/components/brand-mark'
import { Input } from '@pi-meme/ui/components/ui/input'
import { FormField } from '@pi-meme/ui/components/ui/form-field'
import { ScrollArea } from '@pi-meme/ui/components/ui/scroll-area'
import { Textarea } from '@pi-meme/ui/components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@pi-meme/ui/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pi-meme/ui/components/ui/select'
import { CollapsibleSection } from '@pi-meme/ui/components/ui/collapsible'
import { Brain, Eye, EyeOff, Image as ImageIcon, Plus, RefreshCw, Search, Trash2 } from 'lucide-react'
import { cn } from '@pi-meme/ui/lib/utils'

export const apiLabels: Record<ModelApi, string> = {
  'openai-completions': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages',
  'google-generative-ai': 'Google Generative AI',
}
const examples: Record<ModelApi, string> = {
  'openai-completions': 'https://api.openai.com/v1',
  'openai-responses': 'https://api.openai.com/v1',
  'anthropic-messages': 'https://api.anthropic.com',
  'google-generative-ai': 'https://generativelanguage.googleapis.com/v1beta',
}
const jsonText = (value: unknown) => (value ? JSON.stringify(value, null, 2) : '')
function jsonObject(text: string, label: string) {
  if (!text.trim()) return undefined
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (cause) {
    throw new Error(`${label} JSON 格式错误：${String(cause)}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}必须是 JSON 对象`)
  return value as Record<string, unknown>
}
type ModelDraft = ConfiguredModel & { headersText: string; compatText: string }
function defaultThinkingMapping(api: ModelApi, level: ThinkingLevel) {
  if (level !== 'xhigh' && level !== 'max') return undefined
  return api === 'google-generative-ai' ? 'high' : level
}
function draftModel(model: ConfiguredModel, api: ModelApi): ModelDraft {
  return {
    ...model,
    reasoning: model.reasoning ?? true,
    headersText: jsonText(model.headers),
    compatText: jsonText(model.compat),
    thinkingLevelMap: model.thinkingLevelMap
      ? { xhigh: null, max: null, ...model.thinkingLevelMap }
      : {
          xhigh: defaultThinkingMapping(model.api ?? api, 'xhigh')!,
          max: defaultThinkingMapping(model.api ?? api, 'max')!,
        },
  }
}

export function ModelConfigForm({
  provider,
  snapshot,
  busy,
  bridge,
  onSave,
  onClose,
}: {
  provider?: ConfiguredProvider
  snapshot: ModelConfigSnapshot
  busy: boolean
  bridge: Pick<ModelsBridge, 'discoverModels'>
  onSave: (input: SaveModelProvider) => Promise<boolean>
  onClose: () => void
}) {
  const [name, setName] = useState(provider?.name ?? '')
  const [id, setId] = useState(provider?.id ?? `provider-${crypto.randomUUID().slice(0, 8)}`)
  const [api, setApi] = useState<ModelApi>((provider?.api as ModelApi) || 'openai-completions')
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? examples['openai-completions'])
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [clearKey, setClearKey] = useState(false)
  const [models, setModels] = useState<ModelDraft[]>(() =>
    (provider?.models ?? []).map((model) => draftModel(model, api)),
  )
  const [catalog, setCatalog] = useState<ConfiguredModel[]>(provider?.models ?? [])
  const [search, setSearch] = useState('')
  const [customId, setCustomId] = useState('')
  const [headers, setHeaders] = useState(jsonText(provider?.headers))
  const [compat, setCompat] = useState(jsonText(provider?.compat))
  const [fetching, setFetching] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [listError, setListError] = useState('')
  const signature = JSON.stringify([name, id, baseUrl, api, apiKey, clearKey, models, headers, compat])
  const initialSignature = useRef(signature)
  const dirty = signature !== initialSignature.current
  const [discard, setDiscard] = useState(false)
  const locked = saving || fetching

  function close() {
    if (locked) return
    if (dirty) setDiscard(true)
    else onClose()
  }

  function handleApiChange(nextApi: ModelApi) {
    setApi(nextApi)
    if (!provider && (!baseUrl.trim() || Object.values(examples).includes(baseUrl.trim()))) {
      setBaseUrl(examples[nextApi])
    }
  }

  function updateModel(targetId: string, update: Partial<ModelDraft>) {
    setModels((current) => current.map((model) => (model.id === targetId ? { ...model, ...update } : model)))
  }

  function add(model: ConfiguredModel) {
    if (models.some((entry) => entry.id === model.id)) return
    setModels((current) => [...current, draftModel(model, api)])
  }

  async function discover() {
    setFetching(true)
    setListError('')
    try {
      const result = await bridge.discoverModels({
        providerId: provider?.id,
        api,
        baseUrl,
        apiKey: apiKey || undefined,
        clearApiKey: clearKey,
        headers: jsonObject(headers, '服务商请求头') as Record<string, string> | undefined,
      })
      setCatalog(result)
      if (!result.length) setListError('接口没有返回可用模型，可在下方手动添加模型 ID。')
    } catch (cause) {
      setListError(String(cause))
    } finally {
      setFetching(false)
    }
  }

  async function save() {
    setError('')
    setSaving(true)
    try {
      const cleanModels = models.map(({ headersText, compatText, ...model }) => ({
        ...model,
        headers: jsonObject(headersText, `${model.id} 请求头`) as Record<string, string> | undefined,
        compat: jsonObject(compatText, `${model.id} compat`),
      }))
      if (!models.length) throw new Error('请至少选择或手动添加一个模型')
      const ok = await onSave({
        revision: snapshot.revision,
        originalId: provider?.id,
        apiKey: apiKey || undefined,
        clearApiKey: clearKey,
        provider: {
          id,
          name,
          baseUrl,
          api,
          models: cleanModels,
          headers: jsonObject(headers, '服务商请求头') as Record<string, string> | undefined,
          compat: jsonObject(compat, '服务商 compat'),
        },
      })
      if (ok) onClose()
    } catch (cause) {
      setError(String(cause))
    } finally {
      setSaving(false)
    }
  }

  const choices = [...new Map([...catalog, ...models].map((model) => [model.id, model])).values()].filter((model) =>
    `${model.id} ${model.name ?? ''}`.toLowerCase().includes(search.toLowerCase()),
  )
  const selectedIds = new Set(models.map((model) => model.id))
  const selectedChoiceCount = choices.filter((model) => selectedIds.has(model.id)).length
  const allChoicesSelected = choices.length > 0 && selectedChoiceCount === choices.length

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent
        aria-label="模型服务商配置"
        className="w-[min(calc(100vw-2rem),68rem)] max-w-none gap-0 p-0 transition-none outline-none"
        onEscapeKeyDown={(event) => {
          event.preventDefault()
          close()
        }}
        onPointerDownOutside={(event) => {
          event.preventDefault()
          close()
        }}
      >
        <form
          inert={discard}
          className="flex h-[min(calc(100dvh-2.5rem),54rem)] min-h-0 min-w-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3.5 pr-12">
            <div className="flex items-center gap-3">
              <BrandMark size={28} />
              <div>
                <DialogTitle className="text-base">{provider ? '编辑服务商' : '添加服务商'}</DialogTitle>
                <DialogDescription className="mt-0.5 text-xs">配置接口连接并勾选可用模型。</DialogDescription>
              </div>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button
                className={cn(settingsControlClassName, 'whitespace-nowrap')}
                type="button"
                variant="ghost"
                onClick={close}
                disabled={locked}
              >
                取消
              </Button>
              <Button
                className={cn(settingsControlClassName, 'whitespace-nowrap')}
                type="submit"
                disabled={locked || busy}
              >
                {saving ? '保存中…' : '保存服务商'}
              </Button>
            </div>
          </div>

          <ScrollArea type="always" aria-label="模型配置内容" className="min-h-0 min-w-0 flex-1">
            <fieldset disabled={locked} className="min-w-0 space-y-5 p-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField label="服务商名称">
                  <Input
                    className={settingsControlClassName}
                    aria-label="服务商名称"
                    autoFocus
                    required
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="例如：OpenRouter、本地 Ollama"
                  />
                </FormField>
                <FormField label="API 协议">
                  <Select value={api} onValueChange={(value) => handleApiChange(value as ModelApi)}>
                    <SelectTrigger
                      aria-label="API 协议"
                      className="h-8 max-w-full rounded-lg bg-background text-xs shadow-none"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="w-[var(--radix-select-trigger-width)]">
                      {modelApis.map((value) => (
                        <SelectItem key={value} value={value} className="text-xs">
                          {apiLabels[value]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormField>
                <FormField label="Base URL" className="sm:col-span-2">
                  <Input
                    className={cn(settingsControlClassName, 'font-mono')}
                    aria-label="Base URL"
                    required
                    type="url"
                    value={baseUrl}
                    onChange={(event) => setBaseUrl(event.target.value)}
                    placeholder={examples[api]}
                  />
                </FormField>
                <div className="flex min-w-0 flex-col gap-1.5 sm:col-span-2">
                  <label className="text-xs font-medium leading-snug" htmlFor="model-api-key">
                    API Key{provider?.hasApiKey && !clearKey ? '（已配置，留空保留）' : ''}
                  </label>
                  <div className="flex gap-1.5">
                    <Input
                      className={settingsControlClassName}
                      id="model-api-key"
                      aria-label="API Key"
                      type={showKey ? 'text' : 'password'}
                      autoComplete="off"
                      disabled={clearKey}
                      value={apiKey}
                      onChange={(event) => {
                        setApiKey(event.target.value)
                        setClearKey(false)
                      }}
                      placeholder="输入 API Key 或 $环境变量名（本地无鉴权可填 ollama）"
                    />
                    <Button
                      type="button"
                      size="icon"
                      variant="outline"
                      aria-label={showKey ? '隐藏 API Key' : '显示 API Key'}
                      className="size-8 shrink-0 rounded-lg shadow-none"
                      disabled={clearKey}
                      onClick={() => setShowKey((value) => !value)}
                    >
                      {showKey ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                    </Button>
                    {provider?.hasApiKey && (
                      <Button
                        type="button"
                        className={cn(settingsControlClassName, 'shrink-0 whitespace-nowrap')}
                        variant={clearKey ? 'secondary' : 'outline'}
                        onClick={() => {
                          setClearKey((value) => !value)
                          setApiKey('')
                        }}
                      >
                        {clearKey ? '保留原 Key' : '清除 Key'}
                      </Button>
                    )}
                  </div>
                  {clearKey && (
                    <p className="text-[11px] text-amber-600 dark:text-amber-400">保存后将清除已保存的 API Key。</p>
                  )}
                </div>
              </div>

              <CollapsibleSection
                title="高级配置"
                description={`ID: ${id} · 请求头与协议兼容参数`}
                className="bg-card/40 [&>button]:text-xs [&>button>span>span+span]:text-[11px]"
              >
                <div className="space-y-4">
                  <FormField label="服务商 ID">
                    <Input
                      className={cn(settingsControlClassName, 'font-mono')}
                      aria-label="服务商 ID"
                      required
                      pattern="[a-zA-Z0-9][a-zA-Z0-9._-]*"
                      readOnly={Boolean(provider)}
                      value={id}
                      onChange={(event) => setId(event.target.value)}
                      placeholder="例如：my-provider"
                    />
                    <span className="text-[11px] text-muted-foreground">唯一标识，创建后不可修改。</span>
                  </FormField>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <FormField label="请求头 JSON">
                      <Textarea
                        aria-label="服务商请求头 JSON"
                        value={headers}
                        onChange={(event) => setHeaders(event.target.value)}
                        className="rounded-lg font-mono text-xs"
                        placeholder={'{"X-Custom-Header":"value"}'}
                      />
                    </FormField>
                    <FormField label="compat JSON">
                      <Textarea
                        aria-label="服务商 compat JSON"
                        value={compat}
                        onChange={(event) => setCompat(event.target.value)}
                        className="rounded-lg font-mono text-xs"
                        placeholder={'{"supportsDeveloperRole":false}'}
                      />
                    </FormField>
                  </div>
                </div>
              </CollapsibleSection>

              <div className="grid min-h-0 gap-4 lg:grid-cols-2">
                <section
                  aria-label="接口模型列表"
                  className="flex h-[24rem] min-w-0 flex-col gap-2.5 rounded-xl border border-border/70 bg-card/40 p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="whitespace-nowrap text-xs font-medium">接口模型列表</h3>
                    <Button
                      className={cn(settingsControlClassName, 'whitespace-nowrap')}
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void discover()}
                      disabled={!baseUrl}
                    >
                      <RefreshCw className={cn('mr-1.5 size-3.5', fetching && 'animate-spin')} />
                      {fetching ? '获取中…' : '获取模型列表'}
                    </Button>
                  </div>
                  <div className="relative">
                    <Search
                      aria-hidden="true"
                      className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                    />
                    <Input
                      className="h-8 max-w-full rounded-lg pl-8 text-xs shadow-none"
                      aria-label="搜索模型"
                      placeholder="搜索模型 ID 或名称"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                    />
                  </div>
                  {listError && (
                    <p role="alert" className="text-xs text-destructive">
                      {listError}
                    </p>
                  )}
                  <label className="flex cursor-pointer items-center gap-2 text-xs select-none">
                    <input
                      type="checkbox"
                      aria-label="全选当前列表模型"
                      ref={(input) => {
                        if (input) input.indeterminate = selectedChoiceCount > 0 && !allChoicesSelected
                      }}
                      checked={allChoicesSelected}
                      disabled={!choices.length}
                      onChange={(event) => {
                        const checked = event.target.checked
                        setModels((current) => {
                          const choiceIds = new Set(choices.map((model) => model.id))
                          if (!checked) return current.filter((model) => !choiceIds.has(model.id))
                          const currentIds = new Set(current.map((model) => model.id))
                          return [
                            ...current,
                            ...choices
                              .filter((model) => !currentIds.has(model.id))
                              .map((model) => draftModel(model, api)),
                          ]
                        })
                      }}
                      className="accent-primary"
                    />
                    <span className="whitespace-nowrap">全选当前列表</span>
                    <span className="whitespace-nowrap text-muted-foreground tabular-nums">
                      {selectedChoiceCount} / {choices.length}
                    </span>
                  </label>
                  <ScrollArea type="always" aria-label="接口模型滚动列表" className="min-h-0 flex-1">
                    <div className="space-y-1 pr-2">
                      {choices.length ? (
                        choices.map((model) => {
                          const isSelected = selectedIds.has(model.id)
                          return (
                            <label
                              key={model.id}
                              className={cn(
                                'flex cursor-pointer items-start gap-2 rounded-lg p-2 transition-colors',
                                isSelected ? 'bg-secondary/80' : 'hover:bg-secondary/50',
                              )}
                            >
                              <input
                                type="checkbox"
                                aria-label={`选择模型 ${model.id}`}
                                checked={isSelected}
                                onChange={(event) => {
                                  if (event.target.checked) add(model)
                                  else setModels((current) => current.filter((entry) => entry.id !== model.id))
                                }}
                                className="mt-0.5 accent-primary"
                              />
                              <span className="min-w-0 break-all text-xs">
                                <span className="font-mono">{model.id}</span>
                                {model.name && model.name !== model.id && (
                                  <span className="block text-[11px] text-muted-foreground">{model.name}</span>
                                )}
                              </span>
                            </label>
                          )
                        })
                      ) : (
                        <div className="space-y-2 py-8 text-center">
                          <p className="text-[11px] text-muted-foreground">点击“获取模型列表”，或在下方手动输入 ID。</p>
                        </div>
                      )}
                    </div>
                  </ScrollArea>
                  <div className="flex gap-1.5">
                    <Input
                      className={cn(settingsControlClassName, 'font-mono')}
                      aria-label="自定义模型 ID"
                      value={customId}
                      onChange={(event) => setCustomId(event.target.value)}
                      placeholder="手动输入模型 ID"
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          if (customId.trim()) {
                            add({ id: customId.trim() })
                            setCustomId('')
                          }
                        }
                      }}
                    />
                    <Button
                      type="button"
                      className={cn(settingsControlClassName, 'shrink-0 whitespace-nowrap')}
                      variant="secondary"
                      disabled={!customId.trim()}
                      onClick={() => {
                        add({ id: customId.trim() })
                        setCustomId('')
                      }}
                    >
                      <Plus className="mr-1 size-3.5" />
                      添加
                    </Button>
                  </div>
                </section>

                <section
                  aria-label="已选模型设置"
                  className="flex h-[24rem] min-w-0 flex-col gap-2.5 rounded-xl border border-border/70 bg-card/40 p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="whitespace-nowrap text-xs font-medium tabular-nums">已选模型 · {models.length}</h3>
                  </div>
                  <ScrollArea type="always" aria-label="已选模型滚动列表" className="min-h-0 flex-1">
                    <div className="space-y-2.5 pr-2">
                      {!models.length && (
                        <p className="py-10 text-center text-[11px] text-muted-foreground">
                          从左侧勾选或手动添加模型。
                        </p>
                      )}
                      {models.map((model) => {
                        const supportsImage = model.input?.includes('image') ?? false
                        const supportsReasoning = model.reasoning ?? false
                        return (
                          <div
                            key={model.id}
                            className="space-y-2.5 rounded-lg border border-border/50 bg-secondary/35 p-3"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <h4 className="min-w-0 break-all font-mono text-xs font-medium">{model.id}</h4>
                              <Button
                                type="button"
                                className="size-7 shrink-0 rounded-md text-muted-foreground hover:text-destructive"
                                variant="ghost"
                                size="icon"
                                aria-label={`移除模型 ${model.id}`}
                                onClick={() => {
                                  setModels((current) => current.filter((entry) => entry.id !== model.id))
                                }}
                              >
                                <Trash2 className="size-3.5" />
                              </Button>
                            </div>
                            <div className="flex flex-wrap items-center gap-1.5">
                              <button
                                type="button"
                                aria-pressed={supportsReasoning}
                                onClick={() => updateModel(model.id, { reasoning: !supportsReasoning })}
                                className={cn(
                                  'inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-2 py-1 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                                  supportsReasoning
                                    ? 'border-primary/40 bg-primary/10 font-medium text-foreground'
                                    : 'border-border/70 bg-background/60 text-muted-foreground hover:text-foreground',
                                )}
                              >
                                <Brain className="size-3" />
                                支持思考
                              </button>
                              <button
                                type="button"
                                aria-pressed={supportsImage}
                                onClick={() =>
                                  updateModel(model.id, {
                                    input: supportsImage ? ['text'] : ['text', 'image'],
                                  })
                                }
                                className={cn(
                                  'inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-2 py-1 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                                  supportsImage
                                    ? 'border-primary/40 bg-primary/10 font-medium text-foreground'
                                    : 'border-border/70 bg-background/60 text-muted-foreground hover:text-foreground',
                                )}
                              >
                                <ImageIcon className="size-3" />
                                支持图片
                              </button>
                            </div>
                            <FormField label="显示名称">
                              <Input
                                className={settingsControlClassName}
                                aria-label={`${model.id} 显示名称`}
                                value={model.name ?? ''}
                                placeholder={model.id}
                                onChange={(event) => updateModel(model.id, { name: event.target.value || undefined })}
                              />
                            </FormField>
                            <CollapsibleSection title="高级模型参数" variant="inline">
                              <div className="space-y-3">
                                {supportsReasoning && (
                                  <div className="space-y-1.5">
                                    <p className="text-xs font-medium">可用思考档位</p>
                                    <div className="flex flex-wrap gap-1">
                                      {thinkingLevels.map((level) => {
                                        const enabled = model.thinkingLevelMap?.[level] !== null
                                        return (
                                          <button
                                            key={level}
                                            type="button"
                                            aria-label={`${model.id} ${THINKING_LEVEL_LABELS[level]}`}
                                            aria-pressed={enabled}
                                            onClick={() => {
                                              const map = { ...model.thinkingLevelMap }
                                              if (!enabled) {
                                                const value = defaultThinkingMapping(api, level)
                                                if (value === undefined) delete map[level]
                                                else map[level] = value
                                              } else {
                                                map[level] = null
                                              }
                                              updateModel(model.id, { thinkingLevelMap: map })
                                            }}
                                            className={cn(
                                              'whitespace-nowrap rounded-md border px-2 py-0.5 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                                              enabled
                                                ? 'border-primary/40 bg-primary/10 font-medium text-foreground'
                                                : 'border-border/70 bg-background/50 text-muted-foreground hover:text-foreground',
                                            )}
                                          >
                                            {THINKING_LEVEL_LABELS[level]}
                                          </button>
                                        )
                                      })}
                                    </div>
                                  </div>
                                )}
                                <div className="grid grid-cols-2 gap-3">
                                  {(['contextWindow', 'maxTokens'] as const).map((field) => (
                                    <FormField
                                      key={field}
                                      label={field === 'contextWindow' ? '上下文窗口' : '最大输出'}
                                    >
                                      <Input
                                        className={settingsControlClassName}
                                        aria-label={`${model.id} ${field}`}
                                        type="number"
                                        min="1"
                                        step="1"
                                        value={model[field] ?? ''}
                                        placeholder={field === 'contextWindow' ? '128000' : '16384'}
                                        onChange={(event) =>
                                          updateModel(model.id, {
                                            [field]: event.target.value ? Number(event.target.value) : undefined,
                                          })
                                        }
                                      />
                                    </FormField>
                                  ))}
                                </div>
                                {(
                                  [
                                    { field: 'headersText', label: '请求头' },
                                    { field: 'compatText', label: 'compat' },
                                  ] as const
                                ).map(({ field, label }) => (
                                  <FormField key={field} label={`${label} JSON`}>
                                    <Textarea
                                      aria-label={`${model.id} ${label} JSON`}
                                      value={model[field]}
                                      onChange={(event) => updateModel(model.id, { [field]: event.target.value })}
                                      className="rounded-lg font-mono text-xs"
                                    />
                                  </FormField>
                                ))}
                                {supportsReasoning && (
                                  <div className="space-y-2">
                                    <p className="text-xs font-medium">思考等级映射</p>
                                    <div className="grid grid-cols-2 gap-2.5">
                                      {thinkingLevels
                                        .filter((level) => model.thinkingLevelMap?.[level] !== null)
                                        .map((level) => (
                                          <FormField key={level} label={`${THINKING_LEVEL_LABELS[level]}（${level}）`}>
                                            <Input
                                              className={settingsControlClassName}
                                              aria-label={`${model.id} ${level} 映射`}
                                              value={model.thinkingLevelMap?.[level] ?? ''}
                                              placeholder={defaultThinkingMapping(api, level) ?? '默认'}
                                              onChange={(event) => {
                                                const map = { ...model.thinkingLevelMap }
                                                const value = event.target.value || defaultThinkingMapping(api, level)
                                                if (value === undefined) delete map[level]
                                                else map[level] = value
                                                updateModel(model.id, { thinkingLevelMap: map })
                                              }}
                                            />
                                          </FormField>
                                        ))}
                                    </div>
                                  </div>
                                )}
                              </div>
                            </CollapsibleSection>
                          </div>
                        )
                      })}
                    </div>
                  </ScrollArea>
                </section>
              </div>

              {busy && (
                <p role="status" className="text-[11px] text-muted-foreground">
                  Pi 正在运行或连接，请等待完成后保存。
                </p>
              )}
              {error && (
                <p role="alert" className="rounded-md bg-destructive/10 p-3 text-xs text-destructive">
                  {error}
                </p>
              )}
            </fieldset>
          </ScrollArea>
        </form>
        {discard && (
          <div
            role="alertdialog"
            aria-label="放弃模型配置修改"
            className="absolute inset-0 flex items-center justify-center bg-background/90 p-5"
          >
            <div className="space-y-4 rounded-xl border border-border bg-card p-5">
              <p>有未保存的修改，是否放弃？</p>
              <div className="flex justify-end gap-2">
                <Button
                  className={settingsControlClassName}
                  variant="outline"
                  autoFocus
                  onClick={() => setDiscard(false)}
                >
                  继续编辑
                </Button>
                <Button className={settingsControlClassName} variant="destructive" onClick={onClose}>
                  放弃修改
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
