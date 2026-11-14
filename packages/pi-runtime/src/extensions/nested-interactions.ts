import type { InlineExtension } from '@earendil-works/pi-coding-agent'
import {
  piNestedInteractionEntryType,
  piNestedInteractionToolNames,
  readPiNestedInteractionEntry,
  type PiNestedInteractionEntry,
} from '@pi-meme/contracts/pi'

export const nestedInteractionEntry = piNestedInteractionEntryType
const interactionTools = new Set<string>(piNestedInteractionToolNames)

export type NestedInteractionEntry = PiNestedInteractionEntry

/** SDK 的嵌套调用清单不保存结果；补存内置交互与可视化产物，供分支恢复及引用鉴权。 */
export function createNestedInteractionsExtension(): InlineExtension {
  return {
    name: 'pi-meme-nested-interactions',
    factory: (pi) => {
      const calls = new Map<string, { rootToolCallId: string; args: unknown }>()
      pi.on('session_start', () => calls.clear())
      pi.on('agent_end', () => calls.clear())
      pi.on('tool_execution_start', (event) => {
        calls.set(event.toolCallId, {
          rootToolCallId: event.parentToolCallId
            ? (calls.get(event.parentToolCallId)?.rootToolCallId ?? event.parentToolCallId)
            : event.toolCallId,
          args: event.args,
        })
      })
      pi.on('tool_execution_end', (event) => {
        const call = calls.get(event.toolCallId)
        calls.delete(event.toolCallId)
        if (event.parentToolCallId && call && interactionTools.has(event.toolName)) {
          const data: NestedInteractionEntry = {
            rootToolCallId: call.rootToolCallId,
            interaction: {
              id: event.toolCallId,
              parentToolCallId: event.parentToolCallId,
              name: event.toolName,
              args: call.args,
              result: { content: event.result.content, details: event.result.details },
              status: event.isError ? 'error' : 'success',
            },
          }
          pi.appendEntry(nestedInteractionEntry, data)
        }
      })
    },
  }
}

export function readNestedInteractionEntry(value: unknown): NestedInteractionEntry | undefined {
  return readPiNestedInteractionEntry(value)
}
