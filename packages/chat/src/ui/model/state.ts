import type { CollaborationEvent } from '@pi-meme/contracts/collaboration'
import type { PlanEvent } from '@pi-meme/contracts/plan'
import type { AgentAccessEvent } from '@pi-meme/contracts/agent-access'
import type { PiEvent } from '@pi-meme/contracts/pi'
import type { Snapshot, DesktopEvent } from '@pi-meme/contracts/desktop'
import type { ChatState } from './types'
import { sameMessage } from './message-text'
import { updateLiveMessage } from './live-message'

export const emptyChat: ChatState = {
  messages: [],
  live: null,
  stream: { arguments: {}, completed: {} },
  tools: {},
  running: false,
  compacting: null,
  steering: [],
  followUp: [],
}

export function fromSnapshot(snapshot: Snapshot): ChatState {
  const isCompacting = Boolean(snapshot.state.isCompacting)
  const state: ChatState = {
    ...emptyChat,
    messages: snapshot.messages,
    planDocuments: snapshot.planDocuments ?? [],
    agents: snapshot.agents ?? [],
    agentMessages: snapshot.agentMessages ?? [],
    sessionEntries: snapshot.sessionEntries,
    running: snapshot.state.isStreaming || isCompacting,
    compacting: isCompacting ? { active: true } : null,
    tools: {},
  }
  for (const message of snapshot.messages) {
    if (message.role === 'assistant') {
      for (const part of message.content) {
        if (part.type === 'toolCall') {
          state.tools[part.id] = { id: part.id, name: part.name, args: part.arguments, status: 'running' }
        }
      }
    }
    if (message.role === 'toolResult') {
      state.tools[message.toolCallId] = {
        ...state.tools[message.toolCallId],
        id: message.toolCallId,
        name: message.toolName,
        result: message.content,
        status: message.isError ? 'error' : 'success',
      }
    }
  }
  for (const message of snapshot.messages) {
    if (message.role === 'toolResult') restoreNestedTools(state, message)
  }
  return state
}

function restoreNestedTools(
  state: ChatState,
  message: Extract<import('@pi-meme/contracts/pi').PiMessage, { role: 'toolResult' }>,
) {
  const calls = message.nestedCalls?.calls ?? []
  for (const call of calls) {
    const previous = state.tools[call.id]
    const parent = calls
      .filter((other) => other.id !== call.id && call.id.startsWith(`${other.id}/`))
      .sort((a, b) => b.id.length - a.id.length)[0]
    state.tools[call.id] = {
      ...previous,
      id: call.id,
      name: call.name,
      parentToolCallId: previous?.parentToolCallId ?? parent?.id ?? message.toolCallId,
      args: previous?.args ?? call.arguments,
      result:
        previous?.result ??
        (call.status !== 'ok' ? { content: [{ type: 'text', text: call.error ?? '内部调用未完成' }] } : undefined),
      status: call.status === 'ok' ? 'success' : 'error',
    }
  }
}

export function applyEvent(
  state: ChatState,
  event: PiEvent | AgentAccessEvent | PlanEvent | CollaborationEvent,
): ChatState {
  switch (event.type) {
    case 'agents_update':
      return { ...state, agents: event.agents }
    case 'agent_mailbox':
      return state.agentMessages?.some((message) => message.id === event.message.id)
        ? state
        : { ...state, agentMessages: [...(state.agentMessages ?? []), event.message] }
    case 'access_mode_changed':
      return state
    case 'plan_saved': {
      const current = state.planDocuments?.find((document) => document.id === event.document.id)
      if (current && current.revision >= event.document.revision) return state
      return {
        ...state,
        planDocuments: [
          ...(state.planDocuments ?? []).filter((document) => document.id !== event.document.id),
          event.document,
        ],
      }
    }
    case 'agent_start':
      return { ...state, running: true }
    case 'agent_end':
      return state
    case 'compaction_start':
      return {
        ...state,
        running: true,
        compacting: { active: true },
      }
    case 'compaction_end':
      return {
        ...state,
        compacting: null,
      }
    case 'agent_settled':
      return {
        ...state,
        running: false,
        compacting: null,
        live: null,
        stream: emptyChat.stream,
        steering: [],
        followUp: [],
      }
    case 'queue_update':
      return { ...state, steering: event.steering, followUp: event.followUp }
    case 'message_start':
      if (event.message.role !== 'assistant' || state.messages.some((message) => sameMessage(message, event.message)))
        return state
      return { ...state, live: event.message, stream: { arguments: {}, completed: {} } }
    case 'message_update':
      return state.live ? { ...state, ...updateLiveMessage(state.live, state.stream, event) } : state
    case 'message_end': {
      const index = state.messages.findIndex((message) => sameMessage(message, event.message))
      const messages = [...state.messages]
      if (index === -1) messages.push(event.message)
      else messages[index] = event.message
      const next: ChatState = {
        ...state,
        messages,
        live: event.message.role === 'assistant' ? null : state.live,
        stream: event.message.role === 'assistant' ? emptyChat.stream : state.stream,
      }
      if (event.message.role === 'toolResult') {
        const message = event.message
        next.tools = {
          ...state.tools,
          [message.toolCallId]: {
            ...state.tools[message.toolCallId],
            id: message.toolCallId,
            name: message.toolName,
            result: message.content,
            status: message.isError ? 'error' : 'success',
          },
        }
      }
      if (event.message.role === 'toolResult') restoreNestedTools(next, event.message)
      return next
    }
    case 'tool_execution_start':
    case 'tool_execution_update':
    case 'tool_execution_end': {
      const id = event.toolCallId
      const previous = state.tools[id]
      if (previous && previous.status !== 'running' && event.type !== 'tool_execution_end') return state
      return {
        ...state,
        tools: {
          ...state.tools,
          [id]: {
            ...previous,
            id,
            name: event.toolName,
            parentToolCallId: event.parentToolCallId ?? previous?.parentToolCallId,
            args: event.type === 'tool_execution_end' ? previous?.args : event.args,
            result:
              event.type === 'tool_execution_end'
                ? event.result
                : event.type === 'tool_execution_update'
                  ? event.partialResult
                  : previous?.result,
            status: event.type === 'tool_execution_end' ? (event.isError ? 'error' : 'success') : 'running',
          },
        },
      }
    }
  }
}

export function restoreSnapshot(snapshot: Snapshot, buffered: DesktopEvent[] | null): ChatState {
  let next = fromSnapshot(snapshot)
  const events = [
    ...(snapshot.events ?? []),
    ...(buffered ?? []).filter(
      (record) =>
        record.sequence === undefined ||
        snapshot.eventSequence === undefined ||
        record.sequence > snapshot.eventSequence,
    ),
  ]
  const sequences = new Set<number>()
  for (const record of events) {
    if (record.generation !== snapshot.connection.generation) continue
    if (
      snapshot.agent &&
      record.executionGeneration !== undefined &&
      record.executionGeneration !== snapshot.agent.executionGeneration
    )
      continue
    if (record.sessionKey && record.sessionKey !== snapshot.connection.sessionKey) continue
    if (record.sequence !== undefined) {
      if (sequences.has(record.sequence)) continue
      sequences.add(record.sequence)
    }
    if (
      record.generation === snapshot.connection.generation &&
      record.event.type !== 'extension_ui_request' &&
      record.event.type !== 'extension_ui_timeout' &&
      record.event.type !== 'extension_ui_closed'
    ) {
      next = applyEvent(next, record.event)
    }
  }
  return next
}
