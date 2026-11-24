import { useCallback, useMemo, useRef, useState } from 'react'
import type { ModelsBridge } from '@pi-meme/contracts/desktop'
import type {
  ConfiguredModel,
  ConfiguredProvider,
  ModelApi,
  ModelConfigSnapshot,
  SaveModelProvider,
} from '@pi-meme/contracts/model-config'
import { isConfigurableFastModeApi, isOfficialFastModel, modelApis } from '@pi-meme/contracts/model-config'
import { thinkingLevels, type ThinkingLevel } from '@pi-meme/contracts/pi'
import { THINKING_LEVEL_LABELS } from '../thinking-config'
import { Button } from '@pi-meme/ui/components/ui/button'
import { settingsControlClassName } from '@pi-meme/ui/components/settings'
import { BrandMark } from '@pi-meme/ui/components/brand-mark'
import { Input } from '@pi-meme/ui/components/ui/input'
import { FormField } from '@pi-meme/ui/components/ui/form-field'
import { ScrollArea } from '@pi-meme/ui/components/ui/scroll-area'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@pi-meme/ui/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pi-meme/ui/components/ui/select'
import { CollapsibleSection } from '@pi-meme/ui/components/ui/collapsible'
import { TooltipHint, TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'
import {
  AlertCircle,
  Brain,
  Code2,
  Eye,
  EyeOff,
  Image as ImageIcon,
  KeyRound,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Trash2,
  Zap,
} from 'lucide-react'
import { cn } from '@pi-meme/ui/lib/utils'
import { CompatJsonField, HeadersJsonField, JsonCodeEditor } from './json-editor'

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
const capabilityButtonClassName = cn(
  'inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-2 py-1 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50',
  'border-border/70 bg-background/60 text-muted-foreground hover:text-foreground',
  'aria-pressed:border-primary/40 aria-pressed:bg-primary/10 aria-pressed:font-medium aria-pressed:text-foreground',
)
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

function readDraftCompat(text: string) {
  try {
    return jsonObject(text, 'compat') ?? {}
  } catch {
    return null
  }
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

type ProviderJsonPayload = Omit<ConfiguredProvider, 'hasApiKey' | 'api'> & { api: ModelApi }

function validateProviderPayload(value: unknown, originalId?: string): ProviderJsonPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('服务商配置必须是 JSON 对象')
  }
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== 'string' || !raw.id.trim()) throw new Error('缺少有效的服务商 id')
  if (!/^[a-z0-9][\w.-]*$/i.test(raw.id)) {
    throw new Error('服务商 id 只能包含字母、数字、点、下划线和连字符')
  }
  if (originalId && raw.id !== originalId) {
    throw new Error(`编辑时不能更改服务商 id（应保持为 "${originalId}"）`)
  }
  if (typeof raw.name !== 'string' || !raw.name.trim()) throw new Error('缺少有效的服务商 name')
  if (typeof raw.api !== 'string' || !modelApis.includes(raw.api as ModelApi)) {
    throw new Error(`api 必须是 ${modelApis.join(' / ')} 之一`)
  }
  if (typeof raw.baseUrl !== 'string' || !raw.baseUrl.trim()) throw new Error('缺少有效的 baseUrl')
  if (raw.headers !== undefined) {
    if (!raw.headers || typeof raw.headers !== 'object' || Array.isArray(raw.headers)) {
      throw new Error('headers 必须是字符串键值对象')
    }
    for (const [k, v] of Object.entries(raw.headers as Record<string, unknown>)) {
      if (!k.trim() || typeof v !== 'string') throw new Error(`headers.${k} 必须是字符串`)
    }
  }
  if (raw.compat !== undefined && (!raw.compat || typeof raw.compat !== 'object' || Array.isArray(raw.compat))) {
    throw new Error('compat 必须是 JSON 对象')
  }
  if (!Array.isArray(raw.models)) throw new Error('models 必须是数组')
  const seen = new Set<string>()
  const models: ConfiguredModel[] = raw.models.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`models[${index}] 必须是 JSON 对象`)
    }
    const item = entry as Record<string, unknown>
    if (typeof item.id !== 'string' || !item.id.trim()) {
      throw new Error(`models[${index}] 缺少有效的 id`)
    }
    if (seen.has(item.id)) throw new Error(`模型 id "${item.id}" 重复`)
    seen.add(item.id)
    if (item.headers !== undefined) {
      if (!item.headers || typeof item.headers !== 'object' || Array.isArray(item.headers)) {
        throw new Error(`模型 "${item.id}" 的 headers 必须是字符串键值对象`)
      }
      for (const [k, v] of Object.entries(item.headers as Record<string, unknown>)) {
        if (!k.trim() || typeof v !== 'string') throw new Error(`模型 "${item.id}" 的 headers.${k} 必须是字符串`)
      }
    }
    if (item.compat !== undefined && (!item.compat || typeof item.compat !== 'object' || Array.isArray(item.compat))) {
      throw new Error(`模型 "${item.id}" 的 compat 必须是 JSON 对象`)
    }
    return {
      id: item.id,
      ...(typeof item.name === 'string' && item.name.trim() ? { name: item.name } : {}),
      ...(typeof item.api === 'string' && modelApis.includes(item.api as ModelApi)
        ? { api: item.api as ModelApi }
        : {}),
      ...(typeof item.baseUrl === 'string' && item.baseUrl.trim() ? { baseUrl: item.baseUrl } : {}),
      ...(typeof item.contextWindow === 'number' ? { contextWindow: item.contextWindow } : {}),
      ...(typeof item.maxTokens === 'number' ? { maxTokens: item.maxTokens } : {}),
      ...(typeof item.reasoning === 'boolean' ? { reasoning: item.reasoning } : {}),
      ...(Array.isArray(item.input) ? { input: item.input as ('text' | 'image')[] } : {}),
      ...(item.headers ? { headers: item.headers as Record<string, string> } : {}),
      ...(item.compat ? { compat: item.compat as Record<string, unknown> } : {}),
      ...(item.thinkingLevelMap && typeof item.thinkingLevelMap === 'object' && !Array.isArray(item.thinkingLevelMap)
        ? { thinkingLevelMap: item.thinkingLevelMap as Record<string, string | null> }
        : {}),
    }
  })

  return {
    id: raw.id,
    name: raw.name,
    api: raw.api as ModelApi,
    baseUrl: raw.baseUrl,
    ...(raw.headers ? { headers: raw.headers as Record<string, string> } : {}),
    ...(raw.compat ? { compat: raw.compat as Record<string, unknown> } : {}),
    models,
  }
}

export function ModelConfigForm({
  provider,
  snapshot,
  busy,
  bridge,
  initialMode = 'form',
  onSave,
  onClose,
}: {
  provider?: ConfiguredProvider
  snapshot: ModelConfigSnapshot
  busy: boolean
  bridge: Pick<ModelsBridge, 'discoverModels'>
  initialMode?: 'form' | 'json'
  onSave: (input: SaveModelProvider) => Promise<boolean>
  onClose: () => void
}) {
  const initialApi = (provider?.api as ModelApi) || 'openai-completions'
  const initialId = provider?.id ?? `provider-${crypto.randomUUID().slice(0, 8)}`
  const [name, setName] = useState(provider?.name ?? '')
  const [id, setId] = useState(initialId)
  const [api, setApi] = useState<ModelApi>(initialApi)
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? examples['openai-completions'])
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [clearKey, setClearKey] = useState(false)
  const [models, setModels] = useState<ModelDraft[]>(() =>
    (provider?.models ?? []).map((model) => draftModel(model, initialApi)),
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

  const buildPayloadFromForm = useCallback((): ProviderJsonPayload => {
    const cleanModels: ConfiguredModel[] = models.map(({ headersText, compatText, ...model }) => {
      const parsedHeaders = jsonObject(headersText, `${model.id} 请求头`) as Record<string, string> | undefined
      const parsedCompat = jsonObject(compatText, `${model.id} compat`)
      return {
        ...model,
        ...(parsedHeaders ? { headers: parsedHeaders } : { headers: undefined }),
        ...(parsedCompat ? { compat: parsedCompat } : { compat: undefined }),
      }
    })
    const parsedHeaders = jsonObject(headers, '服务商请求头') as Record<string, string> | undefined
    const parsedCompat = jsonObject(compat, '服务商 compat')
    return {
      id,
      name,
      api,
      baseUrl,
      ...(parsedHeaders ? { headers: parsedHeaders } : {}),
      ...(parsedCompat ? { compat: parsedCompat } : {}),
      models: cleanModels,
    }
  }, [api, baseUrl, compat, headers, id, models, name])

  const [mode, setMode] = useState<'form' | 'json'>(initialMode)
  const [providerJson, setProviderJson] = useState(() =>
    JSON.stringify(
      {
        id: initialId,
        name: provider?.name ?? '',
        api: initialApi,
        baseUrl: provider?.baseUrl ?? examples['openai-completions'],
        ...(provider?.headers ? { headers: provider.headers } : {}),
        ...(provider?.compat ? { compat: provider.compat } : {}),
        models: (provider?.models ?? []).map((model) => {
          const { headersText: _h, compatText: _c, ...rest } = draftModel(model, initialApi)
          return rest
        }),
      },
      null,
      2,
    ),
  )

  const formSignature = JSON.stringify([name, id, baseUrl, api, apiKey, clearKey, models, headers, compat])
  const initialFormSignature = useRef(formSignature)
  const initialJsonSignature = useRef(providerJson)
  const dirty =
    mode === 'json'
      ? providerJson !== initialJsonSignature.current || Boolean(apiKey) || clearKey
      : formSignature !== initialFormSignature.current
  const [discard, setDiscard] = useState(false)
  const locked = saving || fetching
  const providerCompat = readDraftCompat(compat)

  const validateFullProviderJson = useCallback(
    (parsed: unknown) => {
      try {
        const payload = validateProviderPayload(parsed, provider?.id)
        if (!payload.models.length) return '请至少配置一个模型（models 数组不能为空）'
        return null
      } catch (cause) {
        return cause instanceof Error ? cause.message : String(cause)
      }
    },
    [provider?.id],
  )

  function switchMode(nextMode: 'form' | 'json') {
    if (nextMode === mode) return
    setError('')
    if (nextMode === 'json') {
      try {
        const payload = buildPayloadFromForm()
        setProviderJson(JSON.stringify(payload, null, 2))
        setMode('json')
      } catch (cause) {
        setError(`请先修正表单中的 JSON 字段：${cause instanceof Error ? cause.message : String(cause)}`)
      }
      return
    }
    try {
      const parsed: unknown = JSON.parse(providerJson)
      const payload = validateProviderPayload(parsed, provider?.id)
      setId(payload.id)
      setName(payload.name)
      setApi(payload.api)
      setBaseUrl(payload.baseUrl)
      setHeaders(jsonText(payload.headers))
      setCompat(jsonText(payload.compat))
      setModels(payload.models.map((model) => draftModel(model, payload.api)))
      setCatalog((current) => [...new Map([...current, ...payload.models].map((m) => [m.id, m])).values()])
      setMode('form')
    } catch (cause) {
      setError(`无法切换到表单模式：${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }

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
      if (isConfigurableFastModeApi(api) && providerCompat && providerCompat.supportsFastMode === undefined) {
        const fastModes = new Map(result.map((model) => [model.id, model.compat?.supportsFastMode]))
        const providerUrl = baseUrl.replace(/\/+$/, '')
        setModels((selected) =>
          selected.map((model) => {
            const discovered = fastModes.get(model.id)
            if (
              typeof discovered !== 'boolean' ||
              (model.api ?? api) !== api ||
              (model.baseUrl && model.baseUrl.replace(/\/+$/, '') !== providerUrl)
            )
              return model
            const modelCompat = readDraftCompat(model.compatText)
            if (!modelCompat || Object.hasOwn(modelCompat, 'supportsFastMode')) return model
            return { ...model, compatText: jsonText({ ...modelCompat, supportsFastMode: discovered }) }
          }),
        )
      }
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
      let payload: ProviderJsonPayload
      if (mode === 'json') {
        let parsed: unknown
        try {
          parsed = JSON.parse(providerJson)
        } catch (cause) {
          throw new Error(`配置 JSON 语法错误：${cause instanceof Error ? cause.message : String(cause)}`)
        }
        payload = validateProviderPayload(parsed, provider?.id)
      } else {
        payload = buildPayloadFromForm()
      }
      if (!payload.models.length) throw new Error('请至少选择或手动添加一个模型')
      const ok = await onSave({
        revision: snapshot.revision,
        originalId: provider?.id,
        apiKey: apiKey || undefined,
        clearApiKey: clearKey,
        provider: payload,
      })
      if (ok) onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const choices = useMemo(
    () =>
      [...new Map([...catalog, ...models].map((model) => [model.id, model])).values()].filter((model) =>
        `${model.id} ${model.name ?? ''}`.toLowerCase().includes(search.toLowerCase()),
      ),
    [catalog, models, search],
  )
  const selectedIds = useMemo(() => new Set(models.map((model) => model.id)), [models])
  const selectedChoiceCount = choices.filter((model) => selectedIds.has(model.id)).length
  const allChoicesSelected = choices.length > 0 && selectedChoiceCount === choices.length

  const renderApiKeyControl = (compactLayout = false) => (
    <div className={cn('flex min-w-0 flex-col gap-1.5', !compactLayout && 'sm:col-span-2')}>
      <div className="flex items-center justify-between gap-2">
        <label className="inline-flex items-center gap-1.5 text-xs font-medium leading-snug" htmlFor="model-api-key">
          {compactLayout && <KeyRound aria-hidden="true" className="size-3.5 text-muted-foreground" />}
          API Key{provider?.hasApiKey && !clearKey ? '（已配置，留空保留）' : ''}
        </label>
        {compactLayout && <span className="text-[11px] text-muted-foreground">独立安全保存，不写入明文 JSON</span>}
      </div>
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
        <TooltipHint content={showKey ? '隐藏 API Key' : '显示 API Key'}>
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
        </TooltipHint>
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
      {clearKey && <p className="text-[11px] text-amber-600 dark:text-amber-400">保存后将清除已保存的 API Key。</p>}
    </div>
  )

  return (
    <TooltipProvider delayDuration={150}>
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
              <div className="flex min-w-0 items-center gap-3">
                <BrandMark size={28} />
                <div className="min-w-0">
                  <DialogTitle className="text-base">{provider ? '编辑服务商' : '添加服务商'}</DialogTitle>
                  <DialogDescription className="mt-0.5 text-xs">
                    {mode === 'json'
                      ? '直接编辑服务商完整 JSON，支持格式化与即时校验。'
                      : '配置接口连接并勾选可用模型。'}
                  </DialogDescription>
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <div
                  role="group"
                  aria-label="编辑模式"
                  className="inline-flex h-8 shrink-0 items-center rounded-lg border border-border/60 bg-secondary/50 p-0.5"
                >
                  <button
                    type="button"
                    aria-pressed={mode === 'form'}
                    disabled={locked}
                    onClick={() => switchMode('form')}
                    className={cn(
                      'inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50',
                      mode === 'form'
                        ? 'bg-background font-medium text-foreground shadow-xs'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <SlidersHorizontal aria-hidden="true" className="size-3.5" />
                    表单
                  </button>
                  <button
                    type="button"
                    aria-pressed={mode === 'json'}
                    disabled={locked}
                    onClick={() => switchMode('json')}
                    className={cn(
                      'inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50',
                      mode === 'json'
                        ? 'bg-background font-medium text-foreground shadow-xs'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <Code2 aria-hidden="true" className="size-3.5" />
                    JSON
                  </button>
                </div>
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
                {mode === 'json' ? (
                  <div className="space-y-4">
                    <div className="rounded-xl border border-border/70 bg-card/40 p-3.5">
                      {renderApiKeyControl(true)}
                    </div>
                    <JsonCodeEditor
                      id="provider-full-json"
                      ariaLabel="服务商完整配置 JSON"
                      value={providerJson}
                      onChange={(next) => {
                        setProviderJson(next)
                        if (error) setError('')
                      }}
                      disabled={locked}
                      allowEmpty={false}
                      requireObject
                      validate={validateFullProviderJson}
                      minHeightClass="min-h-[26rem]"
                      maxHeightClass="max-h-[34rem]"
                      showLineNumbers
                      showMinify
                      onReset={() => {
                        try {
                          setProviderJson(JSON.stringify(buildPayloadFromForm(), null, 2))
                          setError('')
                        } catch {
                          setProviderJson(initialJsonSignature.current)
                        }
                      }}
                      resetLabel="还原为当前表单内容"
                      headerLeft={
                        <span className="font-mono text-[11px] font-medium text-foreground">provider.json</span>
                      }
                      footerHint={
                        <span>
                          支持字段：<code className="rounded bg-secondary px-1 py-0.5 font-mono">id</code>、
                          <code className="rounded bg-secondary px-1 py-0.5 font-mono">name</code>、
                          <code className="rounded bg-secondary px-1 py-0.5 font-mono">api</code>、
                          <code className="rounded bg-secondary px-1 py-0.5 font-mono">baseUrl</code>、
                          <code className="rounded bg-secondary px-1 py-0.5 font-mono">headers</code>、
                          <code className="rounded bg-secondary px-1 py-0.5 font-mono">compat</code>、
                          <code className="rounded bg-secondary px-1 py-0.5 font-mono">models</code>。按{' '}
                          <kbd className="rounded border border-border bg-background px-1 py-0.5 font-mono text-[10px]">
                            Tab
                          </kbd>{' '}
                          缩进，
                          <kbd className="rounded border border-border bg-background px-1 py-0.5 font-mono text-[10px]">
                            ⌘/Ctrl+Shift+F
                          </kbd>{' '}
                          美化格式。
                        </span>
                      }
                    />
                  </div>
                ) : (
                  <>
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
                      {renderApiKeyControl(false)}
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
                        <div className="grid gap-4 lg:grid-cols-2">
                          <HeadersJsonField
                            label="自定义请求头"
                            ariaLabel="服务商请求头 JSON"
                            value={headers}
                            onChange={setHeaders}
                            disabled={locked}
                          />
                          <CompatJsonField
                            label="协议兼容参数（compat）"
                            ariaLabel="服务商 compat JSON"
                            value={compat}
                            onChange={setCompat}
                            disabled={locked}
                          />
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
                                <p className="text-[11px] text-muted-foreground">
                                  点击“获取模型列表”，或在下方手动输入 ID。
                                </p>
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
                          <h3 className="whitespace-nowrap text-xs font-medium tabular-nums">
                            已选模型 · {models.length}
                          </h3>
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
                              const modelApi = model.api ?? api
                              const canConfigureFastMode = isConfigurableFastModeApi(modelApi)
                              const modelCompat = canConfigureFastMode ? readDraftCompat(model.compatText) : null
                              const supportsFastMode =
                                (modelCompat?.supportsFastMode ??
                                  providerCompat?.supportsFastMode ??
                                  isOfficialFastModel(modelApi, model.baseUrl ?? baseUrl, model.id)) === true
                              const fastModeButton = (
                                <button
                                  type="button"
                                  aria-label={`${model.id} 支持快速模式`}
                                  aria-pressed={supportsFastMode}
                                  disabled={!modelCompat}
                                  onClick={() =>
                                    updateModel(model.id, {
                                      compatText: jsonText({ ...modelCompat, supportsFastMode: !supportsFastMode }),
                                    })
                                  }
                                  className={capabilityButtonClassName}
                                >
                                  <Zap className="size-3" />
                                  支持快速模式
                                </button>
                              )
                              return (
                                <div
                                  key={model.id}
                                  className="space-y-2.5 rounded-lg border border-border/50 bg-secondary/35 p-3"
                                >
                                  <div className="flex items-center justify-between gap-2">
                                    <h4 className="min-w-0 break-all font-mono text-xs font-medium">{model.id}</h4>
                                    <TooltipHint content="移除模型">
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
                                    </TooltipHint>
                                  </div>
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <button
                                      type="button"
                                      aria-pressed={supportsReasoning}
                                      onClick={() => updateModel(model.id, { reasoning: !supportsReasoning })}
                                      className={capabilityButtonClassName}
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
                                      className={capabilityButtonClassName}
                                    >
                                      <ImageIcon className="size-3" />
                                      支持图片
                                    </button>
                                    {canConfigureFastMode &&
                                      (modelCompat ? (
                                        fastModeButton
                                      ) : (
                                        <TooltipHint content="请先修正此模型的 compat JSON">
                                          <span tabIndex={0} className="inline-flex">
                                            {fastModeButton}
                                          </span>
                                        </TooltipHint>
                                      ))}
                                  </div>
                                  <FormField label="显示名称">
                                    <Input
                                      className={settingsControlClassName}
                                      aria-label={`${model.id} 显示名称`}
                                      value={model.name ?? ''}
                                      placeholder={model.id}
                                      onChange={(event) =>
                                        updateModel(model.id, { name: event.target.value || undefined })
                                      }
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
                                      <HeadersJsonField
                                        label="请求头"
                                        ariaLabel={`${model.id} 请求头 JSON`}
                                        value={model.headersText}
                                        onChange={(next) => updateModel(model.id, { headersText: next })}
                                        disabled={locked}
                                        compact
                                      />
                                      <CompatJsonField
                                        label="compat"
                                        ariaLabel={`${model.id} compat JSON`}
                                        value={model.compatText}
                                        onChange={(next) => updateModel(model.id, { compatText: next })}
                                        disabled={locked}
                                        compact
                                      />
                                      {supportsReasoning && (
                                        <div className="space-y-2">
                                          <p className="text-xs font-medium">思考等级映射</p>
                                          <div className="grid grid-cols-2 gap-2.5">
                                            {thinkingLevels
                                              .filter((level) => model.thinkingLevelMap?.[level] !== null)
                                              .map((level) => (
                                                <FormField
                                                  key={level}
                                                  label={`${THINKING_LEVEL_LABELS[level]}（${level}）`}
                                                >
                                                  <Input
                                                    className={settingsControlClassName}
                                                    aria-label={`${model.id} ${level} 映射`}
                                                    value={model.thinkingLevelMap?.[level] ?? ''}
                                                    placeholder={defaultThinkingMapping(api, level) ?? '默认'}
                                                    onChange={(event) => {
                                                      const map = { ...model.thinkingLevelMap }
                                                      const value =
                                                        event.target.value || defaultThinkingMapping(api, level)
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
                  </>
                )}

                {busy && (
                  <p role="status" className="text-[11px] text-muted-foreground">
                    Pi 正在运行或连接，请等待完成后保存。
                  </p>
                )}
                {error && (
                  <div
                    role="alert"
                    className="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/8 p-3 text-xs text-destructive"
                  >
                    <AlertCircle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                    <p className="min-w-0 break-words">{error}</p>
                  </div>
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
    </TooltipProvider>
  )
}
