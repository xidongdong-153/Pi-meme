import type { AgentSession, SessionEntry } from '@earendil-works/pi-coding-agent'
import type { PiEvent, PiMessage, PiUiSource } from '@pi-meme/contracts/pi'

export const uiSourceEntry = 'pi-meme.ui-source'
type AgentSource = { pluginId: string; generation: number; path: string }

export function eventUiSource(
  event: PiEvent,
  session: AgentSession,
  agents: AgentSource[] = [],
): PiUiSource | undefined {
  const owner = (file: string): Pick<PiUiSource, 'ownerId' | 'generation'> | undefined => {
    const inline = agents.find((item) => file === `<inline:app-agent:${item.pluginId}:${item.generation}>`)
    if (inline) return { ownerId: inline.pluginId, generation: inline.generation }
    return undefined
  }
  const toolName =
    'toolName' in event
      ? event.toolName
      : 'message' in event && event.message.role === 'toolResult'
        ? event.message.toolName
        : undefined
  if (toolName) {
    const tool = session.extensionRunner.getAllRegisteredTools().find((item) => item.definition.name === toolName)
    const source = tool ? owner(tool.sourceInfo.path) : undefined
    return source ? { ...source, toolName } : undefined
  }
  if (!('message' in event) || event.message.role !== 'custom') return undefined
  const customType = event.message.customType
  const renderer = session.extensionRunner.getMessageRenderer(customType)
  if (!renderer) return undefined
  const extensions = session.resourceLoader.getExtensions().extensions
  const extension = extensions.find((item) => item.messageRenderers.get(customType) === renderer)
  const source = extension ? owner(extension.sourceInfo.path) : undefined
  return source
    ? {
        ...source,
        customType: customType.startsWith(`${source.ownerId}:`)
          ? customType.slice(source.ownerId.length + 1)
          : customType,
      }
    : undefined
}

function messageKey(message: PiMessage) {
  if (message.role === 'toolResult') return `tool:${message.toolCallId}`
  if (message.role === 'custom') return `custom:${message.customType}:${message.timestamp}`
  return undefined
}

export function projectMessageSources(
  entries: readonly SessionEntry[],
  messages: readonly PiMessage[],
  leafId = entries.at(-1)?.id ?? null,
): PiMessage[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const branch: SessionEntry[] = []
  const seen = new Set<string>()
  let entry = leafId ? byId.get(leafId) : undefined
  while (entry && !seen.has(entry.id)) {
    seen.add(entry.id)
    branch.push(entry)
    entry = entry.parentId ? byId.get(entry.parentId) : undefined
  }
  const sources = new Map<string, PiUiSource>()
  const completions = new Map<number, number>()
  for (const entry of branch.reverse()) {
    if (entry.type === 'message' && entry.message.role === 'assistant') {
      const completedAt = Date.parse(entry.timestamp)
      if (Number.isFinite(completedAt) && completedAt >= entry.message.timestamp)
        completions.set(entry.message.timestamp, completedAt)
    }
    if (entry.type !== 'custom' || entry.customType !== uiSourceEntry) continue
    const data = entry.data as { key?: unknown; entryId?: string; source?: Partial<PiUiSource> } | undefined
    if (
      typeof data?.key === 'string' &&
      typeof data.source?.ownerId === 'string' &&
      typeof data.source.generation === 'number'
    ) {
      sources.set(data.key, data.source as PiUiSource)
      const original = data.entryId ? byId.get(data.entryId) : undefined
      if (original?.type === 'custom_message')
        sources.set(
          `custom:${original.customType}:${new Date(original.timestamp).getTime()}`,
          data.source as PiUiSource,
        )
    }
  }
  return messages.map((message) => {
    const key = messageKey(message)
    const source = key ? sources.get(key) : undefined
    const completedAt = message.role === 'assistant' ? completions.get(message.timestamp) : undefined
    return source || completedAt !== undefined
      ? {
          ...message,
          ...(source
            ? { source, ...(message.role === 'custom' && source.customType ? { customType: source.customType } : {}) }
            : {}),
          ...(completedAt !== undefined ? { completedAt } : {}),
        }
      : message
  })
}

export function persistMessageSource(session: AgentSession, event: PiEvent, source: PiUiSource) {
  if (event.type !== 'message_end') return
  const key = messageKey(event.message)
  if (!key) return
  const original = session.sessionManager.getBranch().findLast((entry) => {
    if (event.message.role === 'toolResult')
      return (
        entry.type === 'message' &&
        entry.message.role === 'toolResult' &&
        entry.message.toolCallId === event.message.toolCallId
      )
    return (
      entry.type === 'custom_message' &&
      event.message.role === 'custom' &&
      entry.customType === event.message.customType
    )
  })
  session.sessionManager.appendCustomEntry(uiSourceEntry, { key, entryId: original?.id, source })
}
