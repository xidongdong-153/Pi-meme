import type { GoalEvent } from '@pi-meme/contracts/goal'
import type { CollaborationEvent } from '@pi-meme/contracts/collaboration'
import type { PlanEvent } from '@pi-meme/contracts/plan'
import type { AgentAccessEvent } from '@pi-meme/contracts/agent-access'
import type { PiEvent, PiImage, PiMessage, PiRunInterval } from '@pi-meme/contracts/pi'
import type { ChatBranchAttachment } from '@pi-meme/contracts/chat-attachments'
import { messageAttachmentParts } from '@pi-meme/contracts/chat-attachments'
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
    messagePage: snapshot.messagePage,
    goal: snapshot.goal,
    goalsSupported: snapshot.goalsSupported,
    planDocuments: snapshot.planDocuments ?? [],
    planState: snapshot.planState,
    planCheckpoints: snapshot.planCheckpoints ?? [],
    agents: snapshot.agents ?? [],
    agentMessages: snapshot.agentMessages ?? [],
    sessionEntries: snapshot.sessionEntries,
    branchAttachments: snapshot.branchAttachments ?? [],
    skillUsages: snapshot.state.skillUsages,
    running: snapshot.state.isStreaming || isCompacting || Boolean(snapshot.state.retry),
    paused: snapshot.state.isPaused ?? false,
    queuePaused: snapshot.state.queuePaused ?? false,
    stopped: snapshot.state.stopped ?? false,
    pauseRevision: snapshot.state.pauseRevision ?? 0,
    pauseIntervals: snapshot.state.pauseIntervals ?? [],
    runIntervals: snapshot.state.runIntervals ?? [],
    generationMetrics: snapshot.state.generationMetrics
      ? { ...snapshot.state.generationMetrics, receivedAt: performance.now() }
      : undefined,
    activeMode: snapshot.state.activeMode,
    compacting: isCompacting ? { active: true } : null,
    retry: snapshot.state.retry,
    recovery: snapshot.state.recovery,
    compactionError: snapshot.state.compactionError,
    composerHint: snapshot.state.composerHint,
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
        source: message.source,
        sourceEntry: message.sourceEntry,
        result: { content: message.content, details: message.details },
        status: message.isError ? 'error' : 'success',
      }
    }
  }
  for (const message of snapshot.messages) {
    if (message.role === 'toolResult') restoreNestedTools(state, message)
  }
  return state
}

function extractMessageAttachments(message: PiMessage): ChatBranchAttachment[] {
  if (message.role !== 'user') return []
  const entryId = message.sourceEntry?.id ?? String(message.timestamp)
  let text = ''
  const images: PiImage[] = []
  if (typeof message.content === 'string') {
    text = message.content
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part && typeof part === 'object' && 'type' in part) {
        if (part.type === 'text' && 'text' in part && typeof part.text === 'string') text += part.text
        else if (part.type === 'image' && 'data' in part && 'mimeType' in part) images.push(part)
      }
    }
  }
  const { attachments: files } = messageAttachmentParts(text)
  const result: ChatBranchAttachment[] = []
  for (let i = 0; i < files.length; i++) {
    result.push({
      id: `${entryId}:file:${i}`,
      entryId,
      name: files[i].name,
      path: files[i].path,
    })
  }
  for (let i = 0; i < images.length; i++) {
    result.push({
      id: `${entryId}:image:${i}`,
      entryId,
      name: '图片',
      image: images[i],
    })
  }
  return result
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

function mergeRunIntervals(current: PiRunInterval[] | undefined, incoming: PiRunInterval[] | undefined) {
  if (!incoming) return current
  const intervals = new Map(current?.map((interval) => [interval.startedAt, interval]))
  for (const interval of incoming) {
    const previous = intervals.get(interval.startedAt)
    intervals.set(interval.startedAt, { ...interval, endedAt: previous?.endedAt ?? interval.endedAt })
  }
  return [...intervals.values()].sort((a, b) => a.startedAt - b.startedAt)
}

export function applyEvent(
  state: ChatState,
  event: PiEvent | AgentAccessEvent | PlanEvent | CollaborationEvent | GoalEvent,
): ChatState {
  if ('generationMetrics' in event)
    state = {
      ...state,
      generationMetrics: event.generationMetrics
        ? { ...event.generationMetrics, receivedAt: performance.now() }
        : undefined,
    }
  switch (event.type) {
    case 'agents_update': {
      const root = event.agents.find((agent) => agent.depth === 0 && agent.agentId === agent.rootAgentId)
      const active = root && ['starting', 'running', 'waiting_children', 'waiting_input'].includes(root.status)
      return {
        ...state,
        agents: event.agents,
        agentMessages: event.agentMessages ?? state.agentMessages,
        activeMode: active ? root.mode : undefined,
      }
    }
    case 'agent_mailbox':
      return state.agentMessages?.some((message) => message.id === event.message.id)
        ? state
        : { ...state, agentMessages: [...(state.agentMessages ?? []), event.message] }
    case 'access_mode_changed':
      return state
    case 'goal_updated':
      return { ...state, goal: event.goal, composerHint: undefined }
    case 'goal_cleared':
      return state.goal?.goalId === event.goalId ? { ...state, goal: undefined } : state
    case 'plan_state_changed': {
      if (state.planState && state.planState.revision >= event.state.revision) return state
      return {
        ...state,
        planState: event.state,
        planDocuments: event.state.document ? [event.state.document] : [],
        planCheckpoints:
          event.state.document && event.state.sourceEntryId
            ? [
                ...(state.planCheckpoints ?? []).filter((item) => item.sourceEntryId !== event.state.sourceEntryId),
                { document: event.state.document, sourceEntryId: event.state.sourceEntryId },
              ]
            : state.planCheckpoints,
      }
    }
    case 'plan_saved': {
      if (state.planState) return state
      const current = state.planDocuments?.find((document) => document.id === event.document.id)
      if (current && current.revision >= event.document.revision) return state
      return {
        ...state,
        planDocuments: [event.document],
      }
    }
    case 'recovery_start': {
      const removed = new Set(event.removedMessageTimestamps)
      const failed = new Set(
        state.messages.flatMap((message) =>
          message.role === 'assistant' && message.stopReason === 'error' && removed.has(message.timestamp)
            ? [message.timestamp]
            : [],
        ),
      )
      return {
        ...state,
        messages: state.messages.filter(
          (message) => message.role !== 'assistant' || message.stopReason !== 'error' || !failed.has(message.timestamp),
        ),
        sessionEntries: state.sessionEntries
          ? {
              ...state.sessionEntries,
              entries: state.sessionEntries.entries.map((entry) =>
                entry.role === 'assistant' && entry.messageTimestamp !== undefined && failed.has(entry.messageTimestamp)
                  ? { ...entry, display: false }
                  : entry,
              ),
            }
          : undefined,
        live: null,
        stream: emptyChat.stream,
        retry: undefined,
        recovery: undefined,
      }
    }
    case 'agent_start':
      return {
        ...state,
        running: true,
        recovery: undefined,
        compactionError: undefined,
        composerHint: undefined,
        runIntervals: mergeRunIntervals(state.runIntervals, event.runIntervals),
      }
    case 'composer_hint':
      return { ...state, composerHint: event.text || undefined }
    case 'agent_end':
    case 'turn_start':
      return state
    case 'compaction_start':
      return {
        ...state,
        running: true,
        compacting: { active: true },
        compactionError: undefined,
      }
    case 'compaction_end':
      return {
        ...state,
        compacting: null,
        compactionError: event.aborted ? undefined : event.errorMessage,
        retry: state.retry?.kind === 'summary' ? undefined : state.retry,
      }
    case 'auto_retry_start':
    case 'summarization_retry_scheduled':
      return {
        ...state,
        running: true,
        compactionError: event.type === 'summarization_retry_scheduled' ? undefined : state.compactionError,
        retry: {
          kind: event.type === 'auto_retry_start' ? 'model' : 'summary',
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          errorMessage: event.errorMessage,
        },
      }
    case 'auto_retry_end':
      return { ...state, retry: state.retry?.kind === 'model' ? undefined : state.retry }
    case 'summarization_retry_finished':
      return { ...state, retry: state.retry?.kind === 'summary' ? undefined : state.retry }
    case 'summarization_retry_attempt_start':
      return state
    case 'agent_settled':
      return {
        ...state,
        runIntervals: mergeRunIntervals(state.runIntervals, event.runIntervals),
        running: false,
        activeMode: undefined,
        compacting: null,
        retry: undefined,
        recovery: event.recovery,
        live: null,
        stream: emptyChat.stream,
      }
    case 'pause_update':
      if (event.revision < (state.pauseRevision ?? 0)) return state
      return {
        ...state,
        paused: event.isPaused,
        queuePaused: event.queuePaused,
        pauseRevision: event.revision,
        pauseIntervals: event.pauseIntervals ?? state.pauseIntervals,
      }
    case 'skill_usage_update':
      return { ...state, skillUsages: event.usages }
    case 'queue_update':
      return { ...state, steering: event.steering, followUp: event.followUp }
    case 'stop_update':
      return { ...state, stopped: event.stopped }
    case 'message_start':
      if (event.message.role !== 'assistant' || state.messages.some((message) => sameMessage(message, event.message)))
        return state
      return { ...state, live: event.message, stream: { arguments: {}, completed: {} } }
    case 'message_update':
      return state.live ? { ...state, ...updateLiveMessage(state.live, state.stream, event) } : state
    case 'message_end': {
      let message: PiMessage = event.source ? { ...event.message, source: event.source } : event.message
      const index = state.messages.findIndex((message) => sameMessage(message, event.message))
      const messages = [...state.messages]
      if (index === -1) messages.push(message)
      else {
        message = {
          ...message,
          sourceEntry: message.sourceEntry ?? messages[index]?.sourceEntry,
          source: message.source ?? messages[index]?.source,
          completedAt: message.completedAt ?? messages[index]?.completedAt,
        }
        messages[index] = message
      }
      const next: ChatState = {
        ...state,
        messages,
        live: event.message.role === 'assistant' ? null : state.live,
        stream: event.message.role === 'assistant' ? emptyChat.stream : state.stream,
      }
      if (message.role === 'toolResult') {
        next.tools = {
          ...state.tools,
          [message.toolCallId]: {
            ...state.tools[message.toolCallId],
            id: message.toolCallId,
            name: message.toolName,
            source: message.source,
            sourceEntry: message.sourceEntry,
            result: { content: message.content, details: message.details },
            status: message.isError ? 'error' : 'success',
          },
        }
      }
      if (message.role === 'toolResult') restoreNestedTools(next, message)
      if (message.role === 'user') {
        const added = extractMessageAttachments(message)
        if (added.length) {
          const existingIds = new Set((state.branchAttachments ?? []).map((a) => a.id))
          const newItems = added.filter((a) => !existingIds.has(a.id))
          if (newItems.length) {
            next.branchAttachments = [...(state.branchAttachments ?? []), ...newItems]
          }
        }
      }
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
            source: event.source ?? previous?.source,
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
