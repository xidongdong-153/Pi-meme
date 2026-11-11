import type { Hono } from 'hono'
import type {
  AcceptedMessage,
  AppState,
  Attachment,
  MessageInput,
  QqTarget,
  Task,
  TaskResponse,
} from '../shared/types.js'

export interface BotStore {
  directory: string
  read: () => AppState
  update: <T>(change: (draft: AppState) => T) => Promise<T>
  secret: (ref: string | undefined) => Promise<string | undefined>
  writeSecret: (value: string) => Promise<string>
  deleteSecret: (ref: string | undefined) => Promise<void>
}
export interface QqInteractionSource extends QqTarget {
  inboundKey: string
  platformMessageId: string
}
export interface BotServices {
  store: BotStore
  acceptMessage: (input: MessageInput) => Promise<AcceptedMessage>
  stopTask: (id: string) => Promise<{ taskIds: string[] }>
  respondToTask: (
    taskId: string,
    response: TaskResponse,
    requestId: string,
    qqIdentity?: QqInteractionSource,
  ) => Promise<Task>
  configure: (input: {
    taskId: string
    callId: string
    step: string
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
    path: string
    body?: Record<string, unknown>
    signal: AbortSignal
  }) => Promise<unknown>
  saveAttachment: (input: {
    name: string
    mime: string
    bytes: Uint8Array
    conversationId?: string
    taskId?: string
    generationId?: string
    source: Attachment['source']
  }) => Promise<Attachment>
  readAttachment: (id: string) => Promise<Uint8Array>
}
export interface HostAdapter {
  delegate: (
    input: { hostId: string; projectId: string; prompt: string; taskId: string; sessionId?: string },
    signal?: AbortSignal,
  ) => Promise<string>
  stop: (task: Task) => Promise<boolean>
  close: () => Promise<void>
}
export interface ChannelAdapter {
  start: () => Promise<void>
  flush: () => Promise<void>
  close: () => Promise<void>
}
export interface CapabilityAdapter {
  start: () => Promise<void>
  close: () => Promise<void>
  generateImage: (
    input: { prompt: string; conversationId: string; taskId?: string; modelId?: string; toolCallId?: string },
    signal?: AbortSignal,
  ) => Promise<{ attachmentIds: string[]; generationId: string }>
  explore: (input: { url: string }, signal?: AbortSignal) => Promise<string>
}
export type BotEnvironment = { Variables: { configurationTaskId?: string } }
export type BotApp = Hono<BotEnvironment>
