import { useSyncExternalStore } from 'react'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@pi-meme/ui/components/ui/dialog'

export type PluginConsentRequest = { pluginId: string; title: string; description: string; signal?: AbortSignal }

export class PluginUiConsent {
  private readonly listeners = new Set<() => void>()
  private pending: (PluginConsentRequest & { resolve: (accepted: boolean) => void }) | null = null
  getSnapshot = () => this.pending
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  request = (input: PluginConsentRequest): Promise<boolean> => {
    if (this.pending || input.signal?.aborted) return Promise.resolve(false)
    return new Promise((resolve) => {
      const pending = { ...input, resolve }
      const abort = () => {
        if (this.pending === pending) this.respond(false)
      }
      pending.resolve = (accepted) => {
        input.signal?.removeEventListener('abort', abort)
        resolve(accepted)
      }
      this.pending = pending
      input.signal?.addEventListener('abort', abort, { once: true })
      if (input.signal?.aborted) abort()
      else this.changed()
    })
  }
  respond(accepted: boolean) {
    const pending = this.pending
    this.pending = null
    pending?.resolve(accepted)
    this.changed()
  }
  cancel(pluginId?: string) {
    if (!pluginId || this.pending?.pluginId === pluginId) this.respond(false)
  }
  private changed() {
    for (const listener of this.listeners) listener()
  }
}

export function PluginConsentDialog({ consent }: { consent: PluginUiConsent }) {
  const pending = useSyncExternalStore(consent.subscribe, consent.getSnapshot, consent.getSnapshot)
  return (
    <Dialog
      open={Boolean(pending)}
      onOpenChange={(open) => {
        if (!open) consent.respond(false)
      }}
    >
      <DialogContent>
        <DialogTitle>{pending?.title ?? '确认插件操作'}</DialogTitle>
        <DialogDescription className="whitespace-pre-wrap break-words">
          {pending ? `${pending.pluginId}\n${pending.description}` : ''}
        </DialogDescription>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => consent.respond(false)}>
            取消
          </Button>
          <Button onClick={() => consent.respond(true)}>确认</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
