import type { PiRuntime } from '@pi-meme/pi-runtime/runtime'
import type { PiExtensionUIResponse } from '@pi-meme/contracts/pi'
import { text } from '@pi-meme/contracts/ipc'

export type ExtensionHandlerContext = {
  pi: PiRuntime
}

export function createExtensionHandlers({ pi }: ExtensionHandlerContext) {
  return {
    'pi:extension-ui-response': (sessionKey: unknown, id: unknown, value: unknown) => {
      text(sessionKey)
      text(id)
      if (!value || typeof value !== 'object') throw new Error('扩展交互响应无效')
      const response = value as PiExtensionUIResponse
      if (!(
        ('cancelled' in response && response.cancelled === true && Object.keys(response).length === 1) ||
        ('value' in response && typeof response.value === 'string' && Object.keys(response).length === 1) ||
        ('confirmed' in response && typeof response.confirmed === 'boolean' && Object.keys(response).length === 1)
      ))
        throw new Error('扩展交互响应无效')
      return pi.respondExtensionUI(sessionKey, id, response)
    },
  }
}
