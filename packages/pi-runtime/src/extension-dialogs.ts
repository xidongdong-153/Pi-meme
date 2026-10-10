import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from '@earendil-works/pi-coding-agent'
import type { PiExtensionDialogRequest, PiExtensionUIResponse } from '@pi-meme/contracts/pi'

type PendingDialog = { method: PiExtensionDialogRequest['method']; timer?: ReturnType<typeof setTimeout> }

export class ExtensionDialogs {
  private pending = new Map<string, PendingDialog>()

  constructor(private readonly onTimeout: (id: string) => void) {}

  add(request: RpcExtensionUIRequest) {
    if (
      request.method !== 'select' &&
      request.method !== 'confirm' &&
      request.method !== 'input' &&
      request.method !== 'editor'
    )
      return
    const pending: PendingDialog = { method: request.method }
    if (request.method !== 'editor' && request.timeout && request.timeout > 0) {
      pending.timer = setTimeout(() => {
        this.pending.delete(request.id)
        this.onTimeout(request.id)
      }, request.timeout)
    }
    this.remove(request.id)
    this.pending.set(request.id, pending)
  }

  response(id: string, response: PiExtensionUIResponse): RpcExtensionUIResponse {
    const pending = this.pending.get(id)
    if (!pending) throw new Error('扩展交互已取消或超时')
    if (!('cancelled' in response) && pending.method === 'confirm' && !('confirmed' in response))
      throw new Error('确认弹窗响应无效')
    if (!('cancelled' in response) && pending.method !== 'confirm' && !('value' in response))
      throw new Error('扩展弹窗响应无效')
    return { ...response, type: 'extension_ui_response', id }
  }

  remove(id: string) {
    const pending = this.pending.get(id)
    if (pending?.timer) clearTimeout(pending.timer)
    this.pending.delete(id)
  }

  clear() {
    for (const id of this.pending.keys()) this.remove(id)
  }
}
