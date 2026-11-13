import type { InlineExtension } from '@earendil-works/pi-coding-agent'
import type { PiNestedInteraction } from '@pi-meme/contracts/pi'

export const nestedInteractionEntry = 'pi-meme.nested-interaction'
const interactionTools = new Set([
  'request_user_input',
  'spawn_agent',
  'send_message',
  'followup_task',
  'interrupt_agent',
])

export type NestedInteractionEntry = { rootToolCallId: string; interaction: PiNestedInteraction }

/** SDK 的嵌套调用清单不保存结果；只补存需要在会话中回显的内置交互。 */
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
  if (!value || typeof value !== 'object') return
  const { rootToolCallId, interaction } = value as Partial<NestedInteractionEntry>
  if (
    typeof rootToolCallId !== 'string' ||
    !interaction ||
    typeof interaction.id !== 'string' ||
    typeof interaction.parentToolCallId !== 'string' ||
    !interaction.id.startsWith(`${interaction.parentToolCallId}/`) ||
    !interaction.id.startsWith(`${rootToolCallId}/`) ||
    !interactionTools.has(interaction.name) ||
    !['success', 'error'].includes(interaction.status) ||
    !interaction.result ||
    !Array.isArray(interaction.result.content)
  )
    return
  return { rootToolCallId, interaction }
}
