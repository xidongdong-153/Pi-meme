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
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? examples['openai-completions'])
  const [api, setApi] = useState<ModelApi>((provider?.api as ModelApi) || 'openai-completions')
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
  function updateModel(id: string, update: Partial<ModelDraft>) {
    setModels((current) => current.map((model) => (model.id === id ? { ...model, ...update } : model)))
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
      if (!result.length) setListError('接口没有返回可用模型，可以手动添加模型 ID。')
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
        className="w-[calc(100vw-2rem)] max-w-6xl p-0 gap-0 transition-none outline-none"
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
          className="flex h-[calc(100vh-4rem)] max-h-[56rem] min-h-0 min-w-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4 pr-12">
            <div className="flex items-center gap-3">
              <BrandMark size={32} />
              <div>
                <DialogTitle>{provider ? '编辑服务商' : '添加服务商'}</DialogTitle>
                <DialogDescription className="mt-1">配置 Pi 使用的接口和模型。</DialogDescription>
              </div>
            </div>
            <div className="flex gap-2">
              <Button className={settingsControlClassName} variant="ghost" onClick={close} disabled={locked}>
                取消
              </Button>
              <Button className={settingsControlClassName} type="submit" disabled={locked || busy}>
                {saving ? '正在保存…' : '保存服务商'}
              </Button>
            </div>
          </div>
          <ScrollArea type="always" aria-label="模型配置内容" className="flex-1 min-h-0 min-w-0">
            <fieldset disabled={locked} className="min-w-0 p-5 space-y-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField label="服务商名称">
                  <Input
                    className={settingsControlClassName}
                    aria-label="服务商名称"
                    autoFocus
                    required
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="例如：我的模型服务"
                  />
                </FormField>
                <CollapsibleSection
                  title="高级连接设置"
                  description={`${apiLabels[api]} · ${baseUrl}`}
                  className="sm:col-span-2 bg-card/40 [&>button]:text-xs [&>button>span>span+span]:text-[11px]"
                >
                  <div className="grid gap-4 sm:grid-cols-2">
                    <FormField label="服务商 ID">
                      <Input
                        className={settingsControlClassName}
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
                    <FormField label="API 协议">
                      <Select value={api} onValueChange={(value) => setApi(value as ModelApi)}>
                        <SelectTrigger
                          aria-label="API 协议"
                          className="bg-background h-8 max-w-full rounded-lg text-xs shadow-none"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="w-[var(--radix-select-trigger-width)]">
                          {modelApis.map((value) => (
                            <SelectItem key={value} value={value}>
                              {apiLabels[value]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormField>
                    <FormField label="Base URL">
                      <Input
                        className={settingsControlClassName}
                        aria-label="Base URL"
                        required
                        type="url"
                        value={baseUrl}
                        onChange={(event) => setBaseUrl(event.target.value)}
                        placeholder={examples[api]}
                      />
                      <span className="text-[11px] text-muted-foreground">示例：{examples[api]}</span>
                    </FormField>
                  </div>
                </CollapsibleSection>
                <div className="flex min-w-0 flex-col gap-2 sm:col-span-2">
                  <label className="text-xs font-medium leading-snug" htmlFor="model-api-key">
                    API Key{provider?.hasApiKey && !clearKey ? ' · 已配置，留空保留' : ''}
                  </label>
                  <div className="flex gap-2">
                    <Input
                      className={settingsControlClassName}
                      id="model-api-key"
                      aria-label="API Key"
                      type={showKey ? 'text' : 'password'}
                      autoComplete="off"
                      value={apiKey}
                      onChange={(event) => {
                        setApiKey(event.target.value)
                        setClearKey(false)
                      }}
                      placeholder="输入 Key 或 $环境变量名"
                    />
                    <Button
                      className={settingsControlClassName}
                      variant="outline"
                      onClick={() => setShowKey((value) => !value)}
                    >
                      {showKey ? '隐藏' : '显示'}
                    </Button>
                    {provider?.hasApiKey && (
                      <Button
                        className={settingsControlClassName}
                        variant="outline"
                        onClick={() => {
                          setClearKey((value) => !value)
                          setApiKey('')
                        }}
                      >
                        {clearKey ? '保留原 Key' : '清除 Key'}
                      </Button>
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    本地无鉴权接口可填写占位值，例如 ollama。{clearKey ? '保存后将清除原 Key。' : ''}
                  </p>
                </div>
              </div>
              <CollapsibleSection
                title="服务商高级配置"
                description="请求头与协议兼容参数"
                className="bg-card/40 [&>button]:text-xs [&>button>span>span+span]:text-[11px]"
              >
                <p className="text-[11px] text-muted-foreground">
                  敏感请求头留空保留原值；删除对应键即可清除。JSON 留空则移除该配置。
                </p>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <FormField label="请求头 JSON">
                    <Textarea
                      aria-label="服务商请求头 JSON"
                      value={headers}
                      onChange={(event) => setHeaders(event.target.value)}
                      className="font-mono rounded-lg text-xs"
                      placeholder={'{"X-Custom-Header":"value"}'}
                    />
                  </FormField>
                  <FormField label="compat JSON">
                    <Textarea
                      aria-label="服务商 compat JSON"
                      value={compat}
                      onChange={(event) => setCompat(event.target.value)}
                      className="font-mono rounded-lg text-xs"
                      placeholder={'{"supportsDeveloperRole":false}'}
                    />
                  </FormField>
                </div>
              </CollapsibleSection>
              <div className="grid min-h-0 gap-4 lg:grid-cols-2">
                <section
                  aria-label="接口模型列表"
                  className="flex h-[28rem] min-w-0 flex-col gap-3 rounded-xl border border-border/70 bg-card/40 p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-xs font-medium">接口模型列表</h3>
                    <Button
                      className={settingsControlClassName}
                      variant="outline"
                      size="sm"
                      onClick={() => void discover()}
                      disabled={!baseUrl}
                    >
                      {fetching ? '正在获取…' : '获取模型列表'}
                    </Button>
                  </div>
                  <Input
                    className="h-9 max-w-full rounded-lg text-xs shadow-none"
                    aria-label="搜索模型"
                    placeholder="搜索模型 ID 或名称"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                  {listError && (
                    <p role="alert" className="text-xs text-destructive">
                      {listError}
                    </p>
                  )}
                  <label className="flex items-center gap-2 text-xs">
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
                    全选当前列表
                    <span className="text-muted-foreground">
                      {selectedChoiceCount} / {choices.length}
                    </span>
                  </label>
                  <ScrollArea type="always" aria-label="接口模型滚动列表" className="min-h-0 flex-1">
                    <div className="space-y-1 pr-2">
                      {choices.length ? (
                        choices.map((model) => (
                          <label
                            key={model.id}
                            className="flex cursor-pointer items-start gap-2 rounded-md p-2 hover:bg-secondary"
                          >
                            <input
                              type="checkbox"
                              aria-label={`选择模型 ${model.id}`}
                              checked={selectedIds.has(model.id)}
                              onChange={(event) => {
                                if (event.target.checked) add(model)
                                else setModels((current) => current.filter((entry) => entry.id !== model.id))
                              }}
                              className="mt-1 accent-primary"
                            />
                            <span className="min-w-0 text-xs break-all">
                              <span className="font-mono">{model.id}</span>
                              {model.name && (
                                <span className="block text-[11px] text-muted-foreground">{model.name}</span>
                              )}
                            </span>
                          </label>
                        ))
                      ) : (
                        <p className="py-8 text-center text-[11px] text-muted-foreground">
                          获取模型列表，或在下方手动添加。
                        </p>
                      )}
                    </div>
                  </ScrollArea>
                  <div className="flex gap-2">
                    <Input
                      className={settingsControlClassName}
                      aria-label="自定义模型 ID"
                      value={customId}
                      onChange={(event) => setCustomId(event.target.value)}
                      placeholder="输入模型 ID"
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
                      className={settingsControlClassName}
                      variant="secondary"
                      disabled={!customId.trim()}
                      onClick={() => {
                        add({ id: customId.trim() })
                        setCustomId('')
                      }}
                    >
                      添加模型
                    </Button>
                  </div>
                </section>
                <section
                  aria-label="已选模型设置"
                  className="flex h-[28rem] min-w-0 flex-col gap-3 rounded-xl border border-border/70 bg-card/40 p-3"
                >
                  <h3 className="text-xs font-medium">已选模型 · {models.length}</h3>
                  <ScrollArea type="always" aria-label="已选模型滚动列表" className="min-h-0 flex-1">
                    <div className="space-y-3 pr-2">
                      {!models.length && (
                        <p className="py-8 text-center text-[11px] text-muted-foreground">先选择一个模型。</p>
                      )}
                      {models.map((model) => (
                        <div key={model.id} className="rounded-lg bg-secondary/40 p-3 space-y-3">
                          <div className="flex items-center justify-between gap-2">
                            <h4 className="font-mono text-xs break-all">{model.id}</h4>
                            <Button
                              className={settingsControlClassName}
                              variant="ghost"
                              size="sm"
                              aria-label={`移除模型 ${model.id}`}
                              onClick={() => {
                                setModels((current) => current.filter((entry) => entry.id !== model.id))
                              }}
                            >
                              移除
                            </Button>
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
                              <fieldset className="space-y-2">
                                <legend className="text-xs">思考强度</legend>
                                <p className="text-[11px] text-muted-foreground">
                                  未配置思考档位时默认全选，可按接口支持情况调整。
                                </p>
                                <label className="flex items-center gap-2 text-xs">
                                  <input
                                    type="checkbox"
                                    className="accent-primary"
                                    checked={model.reasoning ?? false}
                                    onChange={(event) => updateModel(model.id, { reasoning: event.target.checked })}
                                  />
                                  支持思考
                                </label>
                                <div className="flex flex-wrap gap-x-3 gap-y-2 text-xs">
                                  {thinkingLevels.map((level) => (
                                    <label key={level} className="flex items-center gap-1.5">
                                      <input
                                        type="checkbox"
                                        className="accent-primary"
                                        aria-label={`${model.id} ${THINKING_LEVEL_LABELS[level]}`}
                                        disabled={!model.reasoning}
                                        checked={model.thinkingLevelMap?.[level] !== null}
                                        onChange={(event) => {
                                          const map = { ...model.thinkingLevelMap }
                                          if (event.target.checked) {
                                            const value = defaultThinkingMapping(api, level)
                                            if (value === undefined) delete map[level]
                                            else map[level] = value
                                          } else map[level] = null
                                          updateModel(model.id, { thinkingLevelMap: map })
                                        }}
                                      />
                                      {THINKING_LEVEL_LABELS[level]}
                                    </label>
                                  ))}
                                </div>
                              </fieldset>
                              <div className="grid grid-cols-2 gap-3">
                                {(['contextWindow', 'maxTokens'] as const).map((field) => (
                                  <FormField key={field} label={field === 'contextWindow' ? '上下文窗口' : '最大输出'}>
                                    <Input
                                      className={settingsControlClassName}
                                      aria-label={`${model.id} ${field}`}
                                      type="number"
                                      min="1"
                                      step="1"
                                      value={model[field] ?? ''}
                                      placeholder={field === 'contextWindow' ? '128000（Pi 默认）' : '16384（Pi 默认）'}
                                      onChange={(event) =>
                                        updateModel(model.id, {
                                          [field]: event.target.value ? Number(event.target.value) : undefined,
                                        })
                                      }
                                    />
                                  </FormField>
                                ))}
                              </div>
                              <div className="flex flex-wrap gap-4 text-xs">
                                <label className="flex items-center gap-2">
                                  <input
                                    type="checkbox"
                                    checked={model.input?.includes('image') ?? false}
                                    onChange={(event) =>
                                      updateModel(model.id, {
                                        input: event.target.checked ? ['text', 'image'] : ['text'],
                                      })
                                    }
                                  />
                                  支持图片
                                </label>
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
                                    className="font-mono rounded-lg text-xs"
                                  />
                                </FormField>
                              ))}
                              {model.reasoning && (
                                <div className="space-y-2">
                                  <p className="text-xs">思考等级映射</p>
                                  <p className="text-[11px] text-muted-foreground">
                                    填写接口接受的参数值；留空使用 Pi 协议默认值。极高和最大需显式映射。
                                  </p>
                                  <div className="grid grid-cols-2 gap-3">
                                    {thinkingLevels
                                      .filter((level) => model.thinkingLevelMap?.[level] !== null)
                                      .map((level) => (
                                        <FormField
                                          key={level}
                                          label={
                                            <>
                                              {THINKING_LEVEL_LABELS[level]}（{level}）
                                            </>
                                          }
                                        >
                                          <Input
                                            className={settingsControlClassName}
                                            aria-label={`${model.id} ${level} 映射`}
                                            value={model.thinkingLevelMap?.[level] ?? ''}
                                            placeholder={defaultThinkingMapping(api, level) ?? 'Pi 协议默认值'}
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
                      ))}
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
            <div className="rounded-xl border border-border bg-card p-5 space-y-4">
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
