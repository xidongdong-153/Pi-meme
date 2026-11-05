import { useState } from 'react'
import { CrossfadeText } from '@pi-meme/ui/components/crossfade-text'
import { RevealContent } from '@pi-meme/ui/components/reveal-content'
import type { PiModel, ThinkingLevel } from '@pi-meme/contracts/pi'
import { thinkingLevels } from '@pi-meme/contracts/pi'
import type { SubagentDefaults, SubagentDefaultsPatch } from '@pi-meme/contracts/settings'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pi-meme/ui/components/ui/select'

const labels: Record<ThinkingLevel, string> = {
  off: '关闭',
  minimal: '极小',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大',
}
const modelKey = (model: Pick<PiModel, 'provider' | 'id'>) => JSON.stringify([model.provider, model.id])

export function SubagentDefaultsSettings({
  models,
  value,
  loading,
  connected,
  pending,
  status,
  failed,
  onSave,
  onModels,
}: {
  models: PiModel[]
  value: SubagentDefaults
  loading: boolean
  connected: boolean
  pending: SubagentDefaultsPatch
  status: Partial<Record<keyof SubagentDefaults, string>>
  failed: SubagentDefaultsPatch
  onSave: (patch: SubagentDefaultsPatch) => void
  onModels: () => void
}) {
  const [hasLoaded, setHasLoaded] = useState(!loading)
  if (!loading && !hasLoaded) setHasLoaded(true)
  const ready = hasLoaded || !loading
  const selectedModel = value.model && models.find((model) => modelKey(model) === modelKey(value.model!))
  const unavailable = value.model && !models.some((model) => modelKey(model) === modelKey(value.model!))
  const fields = [
    { field: 'model' as const, title: '默认模型' },
    { field: 'thinkingLevel' as const, title: '默认思考强度' },
  ]
  return (
    <div className="space-y-4">
      {fields.map(({ field, title }) => (
        <section key={field} className="rounded-xl border border-border bg-card p-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0 space-y-1">
              <h3 className="font-medium">{title}</h3>
            </div>
            <Select
              value={
                !ready
                  ? ''
                  : field === 'model'
                    ? value.model
                      ? modelKey(value.model)
                      : 'inherit'
                    : (value.thinkingLevel ?? 'inherit')
              }
              disabled={!ready || !connected || field in pending}
              onValueChange={(selection) => {
                if (field === 'model') {
                  const model = models.find((entry) => modelKey(entry) === selection)
                  if (selection === 'inherit') onSave({ model: null })
                  else if (model) onSave({ model: { provider: model.provider, id: model.id } })
                } else onSave({ thinkingLevel: selection === 'inherit' ? null : (selection as ThinkingLevel) })
              }}
            >
              <SelectTrigger aria-label={title} className="h-8 w-full text-xs sm:w-60">
                <SelectValue placeholder="读取中…">
                  <CrossfadeText>
                    {!ready
                      ? '读取中…'
                      : field === 'model'
                        ? value.model
                          ? `${value.model.provider} / ${selectedModel?.name ?? value.model.id}${unavailable ? '（当前不可用）' : ''}`
                          : '继承主会话'
                        : value.thinkingLevel
                          ? labels[value.thinkingLevel]
                          : '继承主会话'}
                  </CrossfadeText>
                </SelectValue>
              </SelectTrigger>
              <SelectContent side="bottom">
                <SelectItem value="inherit">继承主会话</SelectItem>
                {field === 'model' ? (
                  <>
                    {unavailable && value.model && (
                      <SelectItem value={modelKey(value.model)} disabled>
                        {value.model.provider} / {value.model.id}（当前不可用）
                      </SelectItem>
                    )}
                    {models.map((model) => (
                      <SelectItem key={modelKey(model)} value={modelKey(model)}>
                        {model.provider} / {model.name ?? model.id}
                      </SelectItem>
                    ))}
                  </>
                ) : (
                  thinkingLevels.map((level) => (
                    <SelectItem key={level} value={level}>
                      {labels[level]}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>
          <RevealContent ready={field === 'model' && ready && Boolean(unavailable || !models.length)}>
            <div className="mt-3 text-sm text-muted-foreground">
              {unavailable ? '已保存的模型当前不可用，请重新选择或恢复继承。' : '暂无可用模型。'}
              <Button variant="link" size="sm" onClick={onModels}>
                前往模型设置
              </Button>
            </div>
          </RevealContent>
          <RevealContent ready={Boolean(status[field])}>
            <p role="status" className="mt-3 text-xs text-muted-foreground">
              <CrossfadeText>{status[field] ?? ''}</CrossfadeText>
              {field in failed && (
                <Button
                  variant="link"
                  size="sm"
                  disabled={!connected || field in pending}
                  onClick={() =>
                    onSave(field === 'model' ? { model: failed.model! } : { thinkingLevel: failed.thinkingLevel! })
                  }
                >
                  重试
                </Button>
              )}
            </p>
          </RevealContent>
        </section>
      ))}
      {!connected && (
        <p role="status" className="text-sm text-destructive">
          服务未连接，暂时无法保存设置。
        </p>
      )}
    </div>
  )
}
