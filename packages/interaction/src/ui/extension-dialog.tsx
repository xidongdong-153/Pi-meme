import { composingKey } from './interaction-queue'
import * as React from 'react'
import { ExtensionEditor } from './extension-editor'
import type { PiExtensionDialogRequest, PiExtensionUIResponse } from '@pi-meme/contracts/pi'
import { Button } from '@pi-meme/ui/components/ui/button'
import { BrandMark } from '@pi-meme/ui/components/brand-mark'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@pi-meme/ui/components/ui/dialog'
import { Input } from '@pi-meme/ui/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pi-meme/ui/components/ui/select'

export function ExtensionDialog({
  request,
  onRespond,
  sourceName,
}: {
  sourceName?: string
  request: Exclude<PiExtensionDialogRequest, { method: 'questions' }>
  onRespond: (id: string, response: PiExtensionUIResponse) => Promise<void>
}) {
  const editorValue = React.useRef(request.method === 'editor' ? (request.prefill ?? '') : '')
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [value, setValue] = React.useState(request.method === 'editor' ? (request.prefill ?? '') : '')
  const [selected, setSelected] = React.useState(request.method === 'select' ? (request.options[0] ?? '') : '')
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState('')

  React.useEffect(() => {
    if (request.method === 'input') {
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [request.id, request.method])

  async function respond(response: PiExtensionUIResponse) {
    if (submitting) return
    setSubmitting(true)
    setError('')
    try {
      await onRespond(request.id, response)
    } catch (cause) {
      setError(String(cause))
      setSubmitting(false)
    }
  }

  const title = request.title || 'Pi 扩展请求'

  return (
    <Dialog open onOpenChange={(open) => !open && void respond({ cancelled: true })}>
      <DialogContent aria-label="Pi 扩展请求" className="max-w-lg p-6 bg-card border-border shadow-2xl">
        <DialogHeader>
          <div className="flex items-center gap-2.5">
            <BrandMark size={28} />
            <DialogTitle className="text-base font-semibold leading-snug break-words">{title}</DialogTitle>
          </div>
          <DialogDescription className="text-xs text-muted-foreground">
            {sourceName ? `来自子代理「${sourceName}」的交互请求。` : '来自当前 Agent 的交互请求。'}
          </DialogDescription>
        </DialogHeader>

        <div className="py-2 space-y-3 min-w-0 max-h-[60vh] overflow-y-auto">
          {request.method === 'confirm' && (
            <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap break-words bg-secondary/30 p-3 rounded-lg border border-border/60">
              {request.message}
            </p>
          )}

          {request.method === 'select' && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">请选择一项</label>
              <Select value={selected} onValueChange={setSelected} disabled={submitting}>
                <SelectTrigger aria-label="扩展选择项" className="w-full text-xs min-w-0" title={selected}>
                  <SelectValue placeholder="点击选择选项" />
                </SelectTrigger>
                <SelectContent className="max-w-[var(--radix-select-trigger-width)]">
                  {request.options.map((option) => (
                    <SelectItem key={option} value={option} className="text-xs" title={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {request.method === 'input' && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">输入内容</label>
              <Input
                ref={inputRef}
                value={value}
                placeholder={request.placeholder}
                disabled={submitting}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key === 'Enter' &&
                    !composingKey({ isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode })
                  ) {
                    e.preventDefault()
                    void respond({ value })
                  }
                }}
                className="text-xs"
              />
            </div>
          )}

          {request.method === 'editor' && <ExtensionEditor request={request} valueRef={editorValue} />}

          {error && (
            <p role="alert" className="text-xs text-destructive font-medium bg-destructive/10 p-2 rounded">
              {error}
            </p>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          {request.method === 'confirm' ? (
            <div className="flex w-full items-center justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={submitting}
                onClick={() => void respond({ confirmed: false })}
                className="text-xs"
              >
                否
              </Button>
              <Button
                variant="default"
                size="sm"
                disabled={submitting}
                onClick={() => void respond({ confirmed: true })}
                className="text-xs"
              >
                确认
              </Button>
            </div>
          ) : (
            <div className="flex w-full items-center justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={submitting}
                onClick={() => void respond({ cancelled: true })}
                className="text-xs"
              >
                取消
              </Button>
              <Button
                variant="default"
                size="sm"
                disabled={submitting || (request.method === 'select' && !request.options.length)}
                onClick={() =>
                  void respond({
                    value:
                      request.method === 'select'
                        ? selected
                        : request.method === 'editor'
                          ? editorValue.current
                          : value,
                  })
                }
                className="text-xs"
              >
                完成
              </Button>
            </div>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
