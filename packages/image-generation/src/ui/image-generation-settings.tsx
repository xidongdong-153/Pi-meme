import { useEffect, useRef, useState } from 'react'
import type {
  ImageGenerationApi,
  ImageGenerationConfig,
  ImageGenerationResult,
  ImageModelConfig,
} from '@pi-meme/contracts/image-generation'
import { imageQualities, imageSizes } from '@pi-meme/contracts/image-generation'
import { CrossfadeText } from '@pi-meme/ui/components/crossfade-text'
import { RevealContent } from '@pi-meme/ui/components/reveal-content'
import { Badge } from '@pi-meme/ui/components/ui/badge'
import { Button } from '@pi-meme/ui/components/ui/button'
import { SettingsCard, SettingsRow, settingsControlClassName } from '@pi-meme/ui/components/settings'
import { Input } from '@pi-meme/ui/components/ui/input'
import { FormField } from '@pi-meme/ui/components/ui/form-field'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@pi-meme/ui/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pi-meme/ui/components/ui/select'
import { OverflowTooltip, TooltipHint, TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'
import { Download, Eye, EyeOff, Loader2, Maximize2, Plus, RefreshCw, Sparkles, Trash2, X } from 'lucide-react'
import { cn } from '@pi-meme/ui/lib/utils'

const sizeLabels = { auto: '自动', '1024x1024': '正方形', '1536x1024': '横向', '1024x1536': '纵向' } as const
const sizeRatios = { auto: '自适应', '1024x1024': '1:1', '1536x1024': '3:2', '1024x1536': '2:3' } as const
const qualityLabels = { auto: '自动', low: '低', medium: '中', high: '高' } as const

type Draft = Omit<ImageModelConfig, 'hasApiKey'> & { apiKey: string; clearApiKey: boolean }
type TestRecord = {
  modelName: string
  modelId: string
  elapsedMs: number
  result: ImageGenerationResult
}

function newDraft(): Draft {
  return {
    id: crypto.randomUUID(),
    name: '',
    baseUrl: 'https://api.openai.com/v1',
    model: '',
    size: 'auto',
    quality: 'auto',
    apiKey: '',
    clearApiKey: false,
  }
}

function SizeGlyph({ size, active }: { size: (typeof imageSizes)[number]; active: boolean }) {
  if (size === 'auto') {
    return <Sparkles className={cn('size-4', active ? 'text-primary' : 'text-muted-foreground')} />
  }
  const shape = size === '1024x1024' ? 'size-4' : size === '1536x1024' ? 'h-3.5 w-5' : 'h-5 w-3.5'
  return (
    <span
      aria-hidden="true"
      className={cn(
        'block rounded-[3px] border-[1.5px]',
        shape,
        active ? 'border-primary bg-primary/15' : 'border-muted-foreground/60',
      )}
    />
  )
}

export function ImageGenerationSettings({ api, hostLabel }: { api?: ImageGenerationApi; hostLabel: string }) {
  const [config, setConfig] = useState<ImageGenerationConfig>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState('')
  const [draft, setDraft] = useState<Draft>()
  const [showKey, setShowKey] = useState(false)
  const [deleting, setDeleting] = useState<ImageModelConfig>()
  const [testing, setTesting] = useState<ImageModelConfig>()
  const [testingName, setTestingName] = useState('')
  const [testRecord, setTestRecord] = useState<TestRecord>()
  const [preview, setPreview] = useState(false)
  const epoch = useRef(0)
  const lock = useRef(false)

  useEffect(() => {
    const current = ++epoch.current
    setConfig(undefined)
    setDraft(undefined)
    setShowKey(false)
    setDeleting(undefined)
    setTesting(undefined)
    setTestingName('')
    setTestRecord(undefined)
    setPreview(false)
    setPending('')
    setError('')
    lock.current = false
    setLoading(true)
    if (api) {
      void api
        .getConfig()
        .then((next) => {
          if (current === epoch.current) setConfig(next)
        })
        .catch((cause: unknown) => {
          if (current === epoch.current) setError(String(cause))
        })
        .finally(() => {
          if (current === epoch.current) setLoading(false)
        })
    } else setLoading(false)
    return () => {
      epoch.current++
    }
  }, [api])

  async function perform(id: string, action: () => Promise<void>) {
    if (lock.current) {
      setError('当前图片设置操作尚未结束，请稍后重试')
      return
    }
    const current = epoch.current
    lock.current = true
    setPending(id)
    setError('')
    try {
      await action()
    } catch (cause) {
      if (current === epoch.current) setError(String(cause))
    } finally {
      if (current === epoch.current) {
        lock.current = false
        setPending('')
      }
    }
  }

  async function change(id: string, action: () => Promise<ImageGenerationConfig>, done?: () => void) {
    const current = epoch.current
    await perform(id, async () => {
      const next = await action()
      if (current !== epoch.current) return
      setConfig(next)
      done?.()
    })
  }

  const imageUrl = testRecord
    ? `data:${testRecord.result.image.mimeType};base64,${testRecord.result.image.data}`
    : undefined
  const existing = draft && config?.models.find((model) => model.id === draft.id)
  const defaultModel = config?.models.find((model) => model.id === config.defaultId)
  const isTesting = pending.startsWith('test:')

  if (!api) return <p role="status">当前版本不支持图片生成，请更新后重试。</p>

  return (
    <TooltipProvider delayDuration={150}>
      <div className="space-y-6" aria-busy={loading || Boolean(pending)}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="whitespace-nowrap text-[11px] text-muted-foreground">
            配置保存至：<CrossfadeText>{hostLabel}</CrossfadeText>
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            <TooltipHint content="刷新配置">
              <Button
                size="icon"
                variant="outline"
                aria-label="刷新图片模型配置"
                className="size-8 rounded-lg shadow-none"
                disabled={loading || pending === 'refresh'}
                onClick={() => void change('refresh', () => api.getConfig())}
              >
                <RefreshCw className={cn('size-3.5', (loading || pending === 'refresh') && 'animate-spin')} />
              </Button>
            </TooltipHint>
            <Button
              className={cn(settingsControlClassName, 'whitespace-nowrap')}
              disabled={!config || Boolean(config.error)}
              onClick={() => {
                setShowKey(false)
                setDraft(newDraft())
              }}
            >
              <Plus className="mr-1 size-3.5" />
              添加模型
            </Button>
          </div>
        </div>

        <SettingsCard>
          <SettingsRow>
            <h3 className="whitespace-nowrap font-medium">默认图片模型</h3>
            <Select
              value={config?.defaultId ?? ''}
              disabled={!config?.models.length || Boolean(config.error) || pending === 'default'}
              onValueChange={(id) => void change('default', () => api.setDefault(id, config!.revision))}
            >
              <SelectTrigger aria-label="默认图片模型" className="h-8 w-60 max-w-full rounded-lg text-xs shadow-none">
                <SelectValue placeholder={!config ? (loading ? '读取中…' : '未读取配置') : '未选择默认模型'}>
                  <CrossfadeText className="min-w-0 max-w-full" textClassName="truncate">
                    {defaultModel
                      ? `${defaultModel.name} · ${defaultModel.model}`
                      : !config
                        ? loading
                          ? '读取中…'
                          : '未读取配置'
                        : '未选择默认模型'}
                  </CrossfadeText>
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {config?.models.map((model) => (
                  <SelectItem key={model.id} value={model.id} className="text-xs">
                    {model.name} · {model.model}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRow>
        </SettingsCard>

        <RevealContent ready={Boolean(config && (config.models.length || !config.error))}>
          <SettingsCard>
            {config && !config.models.length && !config.error && (
              <div className="space-y-3 px-4 py-8 text-center">
                <div className="space-y-1">
                  <p className="font-medium">尚未配置图片模型</p>
                  <p className="text-[11px] text-muted-foreground">添加图片服务后即可在对话中生成与编辑图片。</p>
                </div>
                <Button
                  className={cn(settingsControlClassName, 'whitespace-nowrap')}
                  size="sm"
                  onClick={() => {
                    setShowKey(false)
                    setDraft(newDraft())
                  }}
                >
                  <Plus className="mr-1 size-3.5" />
                  添加模型
                </Button>
              </div>
            )}
            {config?.models.map((model) => {
              const isDefault = model.id === config.defaultId
              const rowTesting = pending === `test:${model.id}`
              return (
                <SettingsRow key={model.id} className={cn('gap-y-2.5', isDefault && 'bg-primary/[0.03]')}>
                  <div className="flex min-w-0 flex-1 basis-52 items-start gap-2.5">
                    <span
                      aria-hidden="true"
                      className={cn(
                        'mt-1.5 size-2 shrink-0 rounded-full',
                        model.hasApiKey ? 'bg-emerald-500' : 'bg-amber-500/70',
                      )}
                    />
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <h3 className="whitespace-nowrap font-medium">{model.name}</h3>
                        {isDefault && (
                          <Badge variant="success" className="h-4.5 whitespace-nowrap px-1.5 text-[10px]">
                            默认
                          </Badge>
                        )}
                        <Badge variant="secondary" className="h-4.5 whitespace-nowrap px-1.5 text-[10px] font-normal">
                          {sizeLabels[model.size]} · 质量{qualityLabels[model.quality]}
                        </Badge>
                        {!model.hasApiKey && (
                          <span className="whitespace-nowrap text-[11px] text-amber-600 dark:text-amber-400">
                            未配 Key
                          </span>
                        )}
                      </div>
                      <div className="flex min-w-0 items-center gap-2 overflow-hidden text-[11px] text-muted-foreground">
                        <OverflowTooltip content={model.model}>
                          <span className="min-w-0 max-w-[55%] truncate font-mono">{model.model}</span>
                        </OverflowTooltip>
                        <span aria-hidden="true" className="shrink-0 opacity-40">
                          ·
                        </span>
                        <OverflowTooltip content={model.baseUrl}>
                          <span className="min-w-0 flex-1 truncate font-mono">{model.baseUrl}</span>
                        </OverflowTooltip>
                      </div>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-nowrap items-center gap-1.5">
                    {!isDefault && (
                      <Button
                        className={cn(settingsControlClassName, 'whitespace-nowrap')}
                        size="sm"
                        variant="ghost"
                        disabled={Boolean(pending)}
                        onClick={() => void change('default', () => api.setDefault(model.id, config.revision))}
                      >
                        设为默认
                      </Button>
                    )}
                    <Button
                      className={cn(settingsControlClassName, 'whitespace-nowrap')}
                      size="sm"
                      variant="outline"
                      disabled={!model.hasApiKey || Boolean(pending)}
                      onClick={() => setTesting(model)}
                    >
                      {rowTesting ? (
                        <>
                          <Loader2 className="mr-1 size-3.5 animate-spin" />
                          生成中…
                        </>
                      ) : (
                        <>
                          <Sparkles className="mr-1 size-3.5" />
                          测试
                        </>
                      )}
                    </Button>
                    <Button
                      className={cn(settingsControlClassName, 'whitespace-nowrap')}
                      size="sm"
                      variant="outline"
                      disabled={Boolean(pending)}
                      onClick={() => {
                        setShowKey(false)
                        setDraft({ ...model, apiKey: '', clearApiKey: false })
                      }}
                    >
                      编辑
                    </Button>
                    <TooltipHint content="删除模型">
                      <Button
                        className="size-8 shrink-0 rounded-lg text-muted-foreground hover:text-destructive"
                        size="icon"
                        variant="ghost"
                        aria-label={`删除 ${model.name}`}
                        disabled={Boolean(pending)}
                        onClick={() => setDeleting(model)}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </TooltipHint>
                  </div>
                </SettingsRow>
              )
            })}
          </SettingsCard>
        </RevealContent>

        <RevealContent ready={Boolean(error || config?.error)}>
          <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-xs text-destructive">
            <CrossfadeText>{error || config?.error || ''}</CrossfadeText>
          </p>
        </RevealContent>

        <RevealContent ready={isTesting || Boolean(imageUrl)}>
          {isTesting ? (
            <SettingsCard className="p-4">
              <div className="flex items-center gap-4">
                <div className="grid size-20 shrink-0 place-items-center rounded-lg bg-secondary/70 animate-pulse">
                  <Loader2 className="size-5 animate-spin text-muted-foreground" />
                </div>
                <div className="min-w-0 space-y-1">
                  <p className="font-medium">正在生成测试图片…</p>
                  <p className="text-[11px] text-muted-foreground">
                    正在调用 {testingName || '图片服务'}，通常需要数秒，请稍候。
                  </p>
                </div>
              </div>
            </SettingsCard>
          ) : (
            imageUrl &&
            testRecord && (
              <SettingsCard className="p-4">
                <div className="flex items-start gap-4">
                  <button
                    type="button"
                    aria-label="预览测试图片"
                    onClick={() => setPreview(true)}
                    className="group relative size-20 shrink-0 overflow-hidden rounded-lg border border-border/60 bg-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <img
                      src={imageUrl}
                      alt="图片服务生成的测试图片"
                      className="size-full object-cover transition-transform duration-200 group-hover:scale-105"
                    />
                    <span className="absolute inset-0 grid place-items-center bg-black/35 opacity-0 transition-opacity group-hover:opacity-100">
                      <Maximize2 className="size-4 text-white" />
                    </span>
                  </button>
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 space-y-0.5">
                        <p className="truncate font-medium">测试结果 · {testRecord.modelName}</p>
                        <p className="text-[11px] text-muted-foreground tabular-nums">
                          {testRecord.modelId} · 耗时 {(testRecord.elapsedMs / 1000).toFixed(1)} 秒
                        </p>
                      </div>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        aria-label="关闭测试结果"
                        className="size-7 shrink-0 rounded-md text-muted-foreground"
                        onClick={() => setTestRecord(undefined)}
                      >
                        <X className="size-3.5" />
                      </Button>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className={cn(settingsControlClassName, 'h-7 whitespace-nowrap px-2.5')}
                        onClick={() => setPreview(true)}
                      >
                        <Maximize2 className="mr-1 size-3" />
                        查看大图
                      </Button>
                      <a
                        href={imageUrl}
                        download="image-generation-test.png"
                        className="inline-flex h-7 items-center whitespace-nowrap rounded-lg px-2.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      >
                        <Download className="mr-1 size-3" />
                        下载原图
                      </a>
                    </div>
                  </div>
                </div>
              </SettingsCard>
            )
          )}
        </RevealContent>

        {draft && config && (
          <Dialog
            open
            onOpenChange={(open) => {
              if (!open && pending !== 'save') setDraft(undefined)
            }}
          >
            <DialogContent className="flex max-h-[calc(100dvh-2rem)] max-w-lg flex-col overflow-hidden">
              <div className="shrink-0 space-y-1.5 pr-6">
                <DialogTitle>{existing ? '编辑图片模型' : '添加图片模型'}</DialogTitle>
                <DialogDescription>填写图片服务信息，保存配置不会发起生成请求。</DialogDescription>
              </div>
              <form
                className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-0.5"
                onSubmit={(event) => {
                  event.preventDefault()
                  void change(
                    'save',
                    () =>
                      api.saveModel({
                        revision: config.revision,
                        model: {
                          id: draft.id,
                          name: draft.name,
                          baseUrl: draft.baseUrl,
                          model: draft.model,
                          size: draft.size,
                          quality: draft.quality,
                        },
                        ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
                        ...(draft.clearApiKey ? { clearApiKey: true } : {}),
                      }),
                    () => setDraft(undefined),
                  )
                }}
              >
                <div className="grid gap-3 sm:grid-cols-2">
                  <FormField label="配置名称">
                    <Input
                      className={settingsControlClassName}
                      required
                      autoFocus
                      placeholder="例如：OpenAI 生图"
                      value={draft.name}
                      onChange={(event) => setDraft((prev) => (prev ? { ...prev, name: event.target.value } : prev))}
                    />
                  </FormField>
                  <FormField label="模型 ID">
                    <Input
                      className={cn(settingsControlClassName, 'font-mono')}
                      required
                      placeholder="例如：gpt-image-1"
                      value={draft.model}
                      onChange={(event) => setDraft((prev) => (prev ? { ...prev, model: event.target.value } : prev))}
                    />
                  </FormField>
                </div>

                <FormField label="Base URL">
                  <Input
                    className={cn(settingsControlClassName, 'font-mono')}
                    required
                    type="url"
                    value={draft.baseUrl}
                    onChange={(event) => setDraft((prev) => (prev ? { ...prev, baseUrl: event.target.value } : prev))}
                  />
                </FormField>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium leading-snug" htmlFor="image-api-key">
                    API Key{existing?.hasApiKey && !draft.clearApiKey ? '（已配置，留空保留）' : ''}
                  </label>
                  <div className="flex gap-1.5">
                    <Input
                      id="image-api-key"
                      className={settingsControlClassName}
                      required={!existing}
                      type={showKey ? 'text' : 'password'}
                      autoComplete="new-password"
                      value={draft.apiKey}
                      placeholder={existing?.hasApiKey ? '留空保留原 Key' : '填写 API Key'}
                      disabled={draft.clearApiKey}
                      onChange={(event) => setDraft((prev) => (prev ? { ...prev, apiKey: event.target.value } : prev))}
                    />
                    <Button
                      type="button"
                      size="icon"
                      variant="outline"
                      aria-label={showKey ? '隐藏 API Key' : '显示 API Key'}
                      className="size-8 shrink-0 rounded-lg shadow-none"
                      disabled={draft.clearApiKey}
                      onClick={() => setShowKey((value) => !value)}
                    >
                      {showKey ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                    </Button>
                    {existing?.hasApiKey && (
                      <Button
                        type="button"
                        variant={draft.clearApiKey ? 'secondary' : 'outline'}
                        className={cn(settingsControlClassName, 'shrink-0 whitespace-nowrap')}
                        onClick={() =>
                          setDraft((prev) => (prev ? { ...prev, apiKey: '', clearApiKey: !prev.clearApiKey } : prev))
                        }
                      >
                        {draft.clearApiKey ? '保留原 Key' : '清除 Key'}
                      </Button>
                    )}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <span className="text-xs font-medium">默认画幅</span>
                  <div role="radiogroup" aria-label="默认尺寸" className="grid grid-cols-4 gap-2">
                    {imageSizes.map((size) => {
                      const active = draft.size === size
                      return (
                        <button
                          key={size}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          onClick={() => setDraft((prev) => (prev ? { ...prev, size } : prev))}
                          className={cn(
                            'flex flex-col items-center justify-center gap-1.5 rounded-xl border px-2 py-2.5 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                            active
                              ? 'border-primary bg-primary/8 text-foreground'
                              : 'border-border/70 bg-secondary/25 text-muted-foreground hover:bg-secondary/50 hover:text-foreground',
                          )}
                        >
                          <div className="grid h-5 place-items-center">
                            <SizeGlyph size={size} active={active} />
                          </div>
                          <span className="whitespace-nowrap text-[11px] font-medium leading-none">
                            {sizeLabels[size]}
                          </span>
                          <span className="whitespace-nowrap text-[10px] leading-none opacity-70">
                            {sizeRatios[size]}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <span className="text-xs font-medium">默认质量</span>
                  <div
                    role="radiogroup"
                    aria-label="默认质量"
                    className="grid grid-cols-4 gap-1 rounded-lg bg-secondary/50 p-1"
                  >
                    {imageQualities.map((quality) => {
                      const active = draft.quality === quality
                      return (
                        <button
                          key={quality}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          onClick={() => setDraft((prev) => (prev ? { ...prev, quality } : prev))}
                          className={cn(
                            'whitespace-nowrap rounded-md py-1.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                            active
                              ? 'bg-card font-medium text-foreground shadow-xs'
                              : 'text-muted-foreground hover:text-foreground',
                          )}
                        >
                          {qualityLabels[quality]}
                        </button>
                      )
                    })}
                  </div>
                </div>

                {error && (
                  <p role="alert" className="text-xs text-destructive">
                    {error}
                  </p>
                )}

                <div className="flex justify-end gap-2 pt-1">
                  <Button
                    className={settingsControlClassName}
                    type="button"
                    variant="outline"
                    disabled={pending === 'save'}
                    onClick={() => setDraft(undefined)}
                  >
                    取消
                  </Button>
                  <Button className={settingsControlClassName} type="submit" disabled={pending === 'save'}>
                    <CrossfadeText reserve={['正在保存…', '保存']}>
                      {pending === 'save' ? '正在保存…' : '保存'}
                    </CrossfadeText>
                  </Button>
                </div>
              </form>
            </DialogContent>
          </Dialog>
        )}

        {deleting && config && (
          <Dialog
            open
            onOpenChange={(open) => {
              if (!open && !pending.startsWith('delete:')) setDeleting(undefined)
            }}
          >
            <DialogContent>
              <DialogTitle>删除 {deleting.name}？</DialogTitle>
              <DialogDescription>
                删除此图片模型配置及安全凭据。若为默认模型，需要重新选择默认图片模型。
              </DialogDescription>
              <div className="flex justify-end gap-2">
                <Button className={settingsControlClassName} variant="outline" onClick={() => setDeleting(undefined)}>
                  取消
                </Button>
                <Button
                  className={settingsControlClassName}
                  variant="destructive"
                  disabled={pending === `delete:${deleting.id}`}
                  onClick={() =>
                    void change(
                      `delete:${deleting.id}`,
                      () => api.deleteModel(deleting.id, config.revision),
                      () => setDeleting(undefined),
                    )
                  }
                >
                  确认删除
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        )}

        {testing && (
          <Dialog open onOpenChange={() => setTesting(undefined)}>
            <DialogContent>
              <DialogTitle>生成测试图片</DialogTitle>
              <DialogDescription>
                将使用 {testing.name}（{testing.model}）生成一张测试图片，可能产生接口费用。
              </DialogDescription>
              <div className="flex justify-end gap-2">
                <Button className={settingsControlClassName} variant="outline" onClick={() => setTesting(undefined)}>
                  取消
                </Button>
                <Button
                  className={settingsControlClassName}
                  onClick={() => {
                    const selected = testing
                    setTesting(undefined)
                    setTestingName(selected.name)
                    const startedAt = Date.now()
                    const current = epoch.current
                    void perform(`test:${selected.id}`, async () => {
                      const next = await api.test(selected.id)
                      if (current === epoch.current) {
                        setTestRecord({
                          modelName: selected.name,
                          modelId: selected.model,
                          elapsedMs: Date.now() - startedAt,
                          result: next,
                        })
                      }
                    })
                  }}
                >
                  开始生成
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        )}

        {preview && imageUrl && (
          <Dialog open onOpenChange={setPreview}>
            <DialogContent className="max-w-2xl">
              <DialogTitle>测试图片预览</DialogTitle>
              <DialogDescription>
                {testRecord ? `${testRecord.modelName} · ${testRecord.modelId}` : '查看图片服务生成的结果。'}
              </DialogDescription>
              <img
                src={imageUrl}
                alt="测试图片原图"
                className="max-h-[70vh] w-full rounded-lg bg-secondary object-contain"
              />
            </DialogContent>
          </Dialog>
        )}
      </div>
    </TooltipProvider>
  )
}
