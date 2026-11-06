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
import { Button } from '@pi-meme/ui/components/ui/button'
import { SettingsCard, SettingsRow, settingsControlClassName } from '@pi-meme/ui/components/settings'
import { Input } from '@pi-meme/ui/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@pi-meme/ui/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pi-meme/ui/components/ui/select'

const sizeLabels = { auto: '自动', '1024x1024': '正方形', '1536x1024': '横向', '1024x1536': '纵向' }
const qualityLabels = { auto: '自动', low: '低', medium: '中', high: '高' }
type Draft = Omit<ImageModelConfig, 'hasApiKey'> & { apiKey: string; clearApiKey: boolean }
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

export function ImageGenerationSettings({ api, hostLabel }: { api?: ImageGenerationApi; hostLabel: string }) {
  const [config, setConfig] = useState<ImageGenerationConfig>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState('')
  const [draft, setDraft] = useState<Draft>()
  const [deleting, setDeleting] = useState<ImageModelConfig>()
  const [testing, setTesting] = useState<ImageModelConfig>()
  const [result, setResult] = useState<ImageGenerationResult>()
  const [preview, setPreview] = useState(false)
  const epoch = useRef(0)
  const lock = useRef(false)
  useEffect(() => {
    const current = ++epoch.current
    setConfig(undefined)
    setDraft(undefined)
    setDeleting(undefined)
    setTesting(undefined)
    setResult(undefined)
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
  const imageUrl = result ? `data:${result.image.mimeType};base64,${result.image.data}` : undefined
  const existing = draft && config?.models.find((model) => model.id === draft.id)
  const defaultModel = config?.models.find((model) => model.id === config.defaultId)

  if (!api) return <p role="status">当前版本不支持图片生成，请更新后重试。</p>
  return (
    <div className="space-y-6" aria-busy={loading || Boolean(pending)}>
      <p className="text-[11px] text-muted-foreground">
        配置保存到：<CrossfadeText>{hostLabel}</CrossfadeText>
      </p>
      <SettingsCard>
        <SettingsRow>
          <div className="space-y-1">
            <h3 className="font-medium">默认图片模型</h3>
          </div>
          <Select
            value={config?.defaultId ?? ''}
            disabled={!config?.models.length || Boolean(config.error) || pending === 'default'}
            onValueChange={(id) => void change('default', () => api.setDefault(id, config!.revision))}
          >
            <SelectTrigger aria-label="默认图片模型" className="w-56 h-8 max-w-full rounded-lg text-xs shadow-none">
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
                <SelectItem key={model.id} value={model.id}>
                  {model.name} · {model.model}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
      </SettingsCard>
      <div className="flex flex-wrap items-center justify-end gap-3">
        <div className="flex gap-2">
          <Button
            className={settingsControlClassName}
            variant="outline"
            disabled={loading || pending === 'refresh'}
            onClick={() => void change('refresh', () => api.getConfig())}
          >
            <CrossfadeText reserve={['刷新', '刷新中…']}>{pending === 'refresh' ? '刷新中…' : '刷新'}</CrossfadeText>
          </Button>
          <Button
            className={settingsControlClassName}
            disabled={!config || Boolean(config.error)}
            onClick={() => setDraft(newDraft())}
          >
            添加模型
          </Button>
        </div>
      </div>
      <RevealContent ready={Boolean(config && (config.models.length || !config.error))}>
        <SettingsCard>
          {config && !config.models.length && !config.error && (
            <div className="px-4 py-8 text-center text-[11px] text-muted-foreground">
              添加图片模型后即可生成和编辑图片。
            </div>
          )}
          {config?.models.map((model) => (
            <SettingsRow key={model.id}>
              <div className="min-w-0 flex-1 basis-48 space-y-1">
                <h3 className="break-words font-medium">{model.name}</h3>
                <p className="break-all text-[11px] text-muted-foreground">
                  <CrossfadeText>{`${model.model} · ${model.hasApiKey ? '已配置 Key' : '未配置 Key'}${model.id === config.defaultId ? ' · 默认' : ''}`}</CrossfadeText>
                </p>
                <p className="break-all text-[11px] text-muted-foreground">{model.baseUrl}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  className={settingsControlClassName}
                  variant="outline"
                  onClick={() => setDraft({ ...model, apiKey: '', clearApiKey: false })}
                >
                  编辑
                </Button>
                <Button
                  className={settingsControlClassName}
                  variant="outline"
                  disabled={!model.hasApiKey || pending === `test:${model.id}`}
                  onClick={() => setTesting(model)}
                >
                  <CrossfadeText reserve={['正在生成测试图片…', '生成测试图片']}>
                    {pending === `test:${model.id}` ? '正在生成测试图片…' : '生成测试图片'}
                  </CrossfadeText>
                </Button>
                <Button
                  className={settingsControlClassName}
                  variant="ghost"
                  disabled={pending === `delete:${model.id}`}
                  onClick={() => setDeleting(model)}
                >
                  删除
                </Button>
              </div>
            </SettingsRow>
          ))}
        </SettingsCard>
      </RevealContent>
      <RevealContent ready={Boolean(error || config?.error)}>
        <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-xs text-destructive">
          <CrossfadeText>{error || config?.error || ''}</CrossfadeText>
        </p>
      </RevealContent>
      <RevealContent ready={Boolean(imageUrl)}>
        {imageUrl && (
          <div className="space-y-2">
            <p className="text-xs">测试图片</p>
            <button type="button" aria-label="预览测试图片" onClick={() => setPreview(true)}>
              <img
                src={imageUrl}
                alt="图片服务生成的测试图片"
                className="size-32 rounded-lg object-contain bg-secondary"
              />
            </button>
            <div>
              <a href={imageUrl} download="image-generation-test.png" className="text-xs underline">
                下载原图
              </a>
            </div>
          </div>
        )}
      </RevealContent>
      {draft && config && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && pending !== 'save') setDraft(undefined)
          }}
        >
          <DialogContent>
            <DialogTitle>{existing ? '编辑图片模型' : '添加图片模型'}</DialogTitle>
            <DialogDescription>填写图片服务信息。保存配置不会发起生成请求。</DialogDescription>
            <form
              className="space-y-4"
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
              <label className="block space-y-1 text-xs">
                配置名称
                <Input
                  className={settingsControlClassName}
                  required
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
              </label>
              <label className="block space-y-1 text-xs">
                Base URL
                <Input
                  className={settingsControlClassName}
                  required
                  type="url"
                  value={draft.baseUrl}
                  onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
                />
              </label>
              <label className="block space-y-1 text-xs">
                API Key
                <Input
                  className={settingsControlClassName}
                  required={!existing}
                  type="password"
                  autoComplete="new-password"
                  value={draft.apiKey}
                  placeholder={existing?.hasApiKey ? '已配置，留空保留原值' : '填写 API Key'}
                  disabled={draft.clearApiKey}
                  onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
                />
              </label>
              {existing?.hasApiKey && (
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={draft.clearApiKey}
                    onChange={(event) => setDraft({ ...draft, apiKey: '', clearApiKey: event.target.checked })}
                  />
                  清除已保存的 API Key
                </label>
              )}
              <label className="block space-y-1 text-xs">
                模型 ID
                <Input
                  className={settingsControlClassName}
                  required
                  value={draft.model}
                  onChange={(event) => setDraft({ ...draft, model: event.target.value })}
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1 text-xs">
                  <span>默认尺寸</span>
                  <Select
                    value={draft.size}
                    onValueChange={(value) => setDraft({ ...draft, size: value as Draft['size'] })}
                  >
                    <SelectTrigger className={settingsControlClassName} aria-label="默认尺寸">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {imageSizes.map((size) => (
                        <SelectItem key={size} value={size}>
                          {sizeLabels[size]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1 text-xs">
                  <span>默认质量</span>
                  <Select
                    value={draft.quality}
                    onValueChange={(value) => setDraft({ ...draft, quality: value as Draft['quality'] })}
                  >
                    <SelectTrigger className={settingsControlClassName} aria-label="默认质量">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {imageQualities.map((quality) => (
                        <SelectItem key={quality} value={quality}>
                          {qualityLabels[quality]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {error && (
                <p role="alert" className="text-xs text-destructive">
                  {error}
                </p>
              )}
              <div className="flex justify-end gap-2">
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
            <DialogDescription>删除配置及其凭据。若为默认模型，需要重新选择默认图片模型。</DialogDescription>
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
              将使用 {testing.name} 的 {testing.model} 生成一张图片，可能产生费用。成功只表示生图可用，编辑需另行验证。
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
                  const current = epoch.current
                  void perform(`test:${selected.id}`, async () => {
                    const next = await api.test(selected.id)
                    if (current === epoch.current) setResult(next)
                  })
                }}
              >
                生成
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
      {preview && imageUrl && (
        <Dialog open onOpenChange={setPreview}>
          <DialogContent>
            <DialogTitle>测试图片</DialogTitle>
            <DialogDescription>查看图片服务生成的结果。</DialogDescription>
            <img src={imageUrl} alt="测试图片原图" className="max-h-[70vh] w-full object-contain" />
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
