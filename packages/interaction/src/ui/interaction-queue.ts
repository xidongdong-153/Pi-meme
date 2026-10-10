import type { PendingInteraction } from '@pi-meme/contracts/collaboration'
import type { PiExtensionDialogRequest, PiExtensionEvent } from '@pi-meme/contracts/pi'

export type InteractionSource = Pick<PendingInteraction, 'sessionKey' | 'executionGeneration'> & {
  source?: PendingInteraction['source']
}
export type SourcedDialog = PiExtensionDialogRequest & InteractionSource & { requestId: string }
export function interactionKey(sessionKey: string, generation: number, id: string) {
  return `${sessionKey}:${generation}:${id}`
}

export class InteractionQueue {
  private dialogs: SourcedDialog[] = []
  get all() {
    return this.dialogs
  }
  get(id: string) {
    return this.dialogs.find((dialog) => dialog.id === id)
  }
  receive(event: PiExtensionEvent, context: InteractionSource) {
    const id = interactionKey(context.sessionKey, context.executionGeneration, event.id)
    if (event.type === 'extension_ui_timeout' || event.type === 'extension_ui_closed') this.remove(id)
    else if (['select', 'confirm', 'input', 'editor'].includes(event.method)) {
      this.dialogs = [
        ...this.dialogs.filter((dialog) => dialog.id !== id),
        { ...(event as PiExtensionDialogRequest), ...context, requestId: event.id, id },
      ]
    }
    return this.dialogs
  }
  remove(id: string) {
    this.dialogs = this.dialogs.filter((dialog) => dialog.id !== id)
  }
  restore(rootSessionKey: string | undefined, pending: PendingInteraction[]) {
    this.dialogs = [
      ...this.dialogs.filter((dialog) => (dialog.source?.rootSessionKey ?? dialog.sessionKey) !== rootSessionKey),
    ]
    for (const { request, ...context } of pending) this.receive(request, context)
    return this.dialogs
  }
}

export function composingKey(event: { isComposing?: boolean; keyCode?: number }) {
  return event.isComposing === true || event.keyCode === 229
}
