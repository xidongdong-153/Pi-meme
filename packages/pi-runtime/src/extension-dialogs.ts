import type { RpcExtensionUIRequest } from '@earendil-works/pi-coding-agent'
import type { PiExtensionDialogRequest, PiExtensionUIResponse } from '@pi-meme/contracts/pi'
import type { PiUserInputRequest } from '@pi-meme/contracts/user-input'
import { validateExtensionDialogResponse, validateUserInputQuestions } from '@pi-meme/contracts/user-input'

type PendingDialog = { request: PiExtensionDialogRequest; timer?: ReturnType<typeof setTimeout> }

export class ExtensionDialogs {
  private pending = new Map<string, PendingDialog>()

  constructor(private readonly onTimeout: (id: string) => void) {}

  add(request: RpcExtensionUIRequest | PiUserInputRequest) {
    if (
      request.method !== 'select' &&
      request.method !== 'confirm' &&
      request.method !== 'input' &&
      request.method !== 'editor' &&
      request.method !== 'questions'
    )
      return
    if (this.pending.has(request.id)) throw new Error('扩展交互请求 id 不能重复')
    if (request.method === 'questions') validateUserInputQuestions(request.questions)
    const pending: PendingDialog = { request }
    if (request.method !== 'editor' && request.timeout && request.timeout > 0) {
      pending.timer = setTimeout(() => {
        this.pending.delete(request.id)
        this.onTimeout(request.id)
      }, request.timeout)
    }
    this.pending.set(request.id, pending)
  }

  response(
    id: string,
    response: PiExtensionUIResponse,
  ): PiExtensionUIResponse & { type: 'extension_ui_response'; id: string } {
    const pending = this.pending.get(id)
    if (!pending) throw new Error('扩展交互已取消或超时')
    validateExtensionDialogResponse(pending.request, response)
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
