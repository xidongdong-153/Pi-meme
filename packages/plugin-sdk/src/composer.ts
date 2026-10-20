import type { ProjectRef, SessionRef } from '@pi-meme/contracts/app-host'
import type { ClientProcessingAudit } from '@pi-meme/contracts/plan'
import type { MessageRef } from '@pi-meme/contracts/plugin-ui-data'
import type { Disposer } from './scope'

export type ComposerRef = {
  id: string
  epoch: number
  target:
    | { kind: 'project-draft'; draftKey: string; project?: ProjectRef; hostId?: string }
    | { kind: 'standalone-draft'; draftKey: string; hostId?: string }
  session?: SessionRef
  context: { kind: 'draft' } | { kind: 'edit-message'; message: MessageRef } | { kind: 'edit-queue'; inputId: string }
}
export type ComposerInline =
  | { kind: 'text'; text: string }
  | { kind: 'skill'; id: string; revision: string; name: string }
  | { kind: 'agent-plugin'; id: string; name: string }
export type ComposerSelection = { anchor: number; focus: number; revision: number }
export type ComposerAttachmentView = {
  id: string
  name: string
  kind: 'file' | 'image'
  status: 'uploading' | 'ready'
  progress?: number
  mimeType?: string
  ownerPluginId?: string
}
export type ComposerIntent = 'message' | 'edit-message' | 'edit-queue' | 'start-goal'
export type PreparedComposerInput = {
  document: readonly ComposerInline[]
  attachmentIds: readonly string[]
}
export type BeforeSendHook = {
  id: string
  title: string
  order?: number
  intents?: readonly ComposerIntent[]
  process: (input: {
    attemptId: string
    invocationId: string
    ref: ComposerRef
    intent: ComposerIntent
    draft: PreparedComposerInput
    signal: AbortSignal
  }) =>
    | { kind: 'pass' }
    | { kind: 'replace'; input: PreparedComposerInput }
    | { kind: 'block'; reason: string }
    | Promise<{ kind: 'pass' } | { kind: 'replace'; input: PreparedComposerInput } | { kind: 'block'; reason: string }>
}
export type RegisteredBeforeSendHook = BeforeSendHook & { pluginId: string; generation: number }
export type ComposerProcessingRecord = ClientProcessingAudit
export type ComposerProcessingFailure = {
  attemptId: string
  pluginId: string
  hookId: string
  title: string
  reason: string
}
export type ComposerView = {
  ref: ComposerRef
  revision: number
  document: readonly ComposerInline[]
  selection: ComposerSelection | null
  selectionRevision: number
  capabilities: readonly ('read' | 'write' | 'attachments' | 'submit')[]
  blockedReasons: Readonly<Record<string, string>>
  attachments: readonly ComposerAttachmentView[]
  composing: boolean
  editable: boolean
  canSubmit: boolean
  disabledReason?: string
  submissionState: 'idle' | 'preparing' | 'blocked' | 'dispatching'
  processors: readonly { pluginId: string; hookId: string; title: string; generation: number }[]
  failure?: ComposerProcessingFailure
}
export type ComposerEditResult =
  { status: 'applied'; revision: number } | { status: 'rejected'; code: string; reason: string }
export type ComposerSubmitResult =
  | { status: 'submitted'; clientRequestId: string }
  | { status: 'cancelled'; reason: string }
  | { status: 'blocked'; code: string; reason: string }
export type ComposerStep =
  | { kind: 'replace'; from: number; to: number; content: readonly ComposerInline[] }
  | { kind: 'remove-attachment'; id: string }
  | { kind: 'reorder-attachments'; ids: readonly string[] }
export type ComposerAdapter = {
  current: () => ComposerView | null
  getSnapshot: (ref: ComposerRef) => ComposerView | null
  subscribe: (ref: ComposerRef, listener: () => void) => Disposer
  apply: (
    ref: ComposerRef,
    input: {
      expectedRevision: number
      steps: readonly ComposerStep[]
      selection?: Omit<ComposerSelection, 'revision'>
    },
  ) => ComposerEditResult
  focus: (ref: ComposerRef, selection?: Omit<ComposerSelection, 'revision'>) => ComposerEditResult
  addAttachments: (
    ref: ComposerRef,
    files: readonly { name: string; data: Blob }[],
    options?: { signal?: AbortSignal },
  ) => Promise<ComposerEditResult>
  cancelAttachment: (ref: ComposerRef, id: string) => ComposerEditResult
  selectAgentPlugin: (ref: ComposerRef, pluginId: string) => Promise<ComposerEditResult>
  removeAgentPlugin: (ref: ComposerRef, pluginId: string) => Promise<ComposerEditResult>
  submit: (ref: ComposerRef, input: { expectedRevision: number; signal?: AbortSignal }) => Promise<ComposerSubmitResult>
}
export type ComposerApi = Omit<ComposerAdapter, 'apply'> & {
  apply: (...args: Parameters<ComposerAdapter['apply']>) => Promise<ComposerEditResult>
  beforeSend: { register: (hook: BeforeSendHook) => Disposer }
}
