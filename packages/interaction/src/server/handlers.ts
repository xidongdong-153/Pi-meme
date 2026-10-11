import type { PiRuntime } from '@pi-meme/pi-runtime/runtime'
import { validateExtensionUIResponse } from '@pi-meme/contracts/user-input'
import { text } from '@pi-meme/contracts/ipc'

export type ExtensionHandlerContext = {
  pi: PiRuntime
}

export function createExtensionHandlers({ pi }: ExtensionHandlerContext) {
  return {
    'pi:extension-ui-response': (sessionKey: unknown, id: unknown, value: unknown) => {
      text(sessionKey)
      text(id)
      validateExtensionUIResponse(value)
      return pi.respondExtensionUI(sessionKey, id, value)
    },
  }
}
