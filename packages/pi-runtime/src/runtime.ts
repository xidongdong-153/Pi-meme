import type {
  MessageOptions,
  QueuedInput,
  TaskMode,
  EditMessageOptions,
  EditMessageResult,
} from '@pi-meme/contracts/plan'
import type { AgentAccessMode } from '@pi-meme/contracts/agent-access'
import type { InlineExtension } from '@earendil-works/pi-coding-agent'
import type { Connection, SessionSelectionResult, Snapshot } from '@pi-meme/contracts/desktop'
import type { PiImage, PiModel, PiQueuedMessages, PiSlashCommand, PiState, ThinkingLevel } from '@pi-meme/contracts/pi'
import type { SkillReference } from '@pi-meme/contracts/skills'
import type { ToolExecutionSettings } from '@pi-meme/contracts/settings'

export type ModelRestore = { sessionFile?: string; model?: PiModel; thinkingLevel?: ThinkingLevel }

/** 桌面端对 Pi 运行时的完整需求面：进程内 SDK 会话池实现它，功能包只依赖这个接口。 */
export interface PiRuntime {
  configureCapabilities: (value: ToolExecutionSettings) => void
  configureInlineExtensions: (extensions: InlineExtension[]) => void
  configureDefaultAccessMode: (mode: AgentAccessMode) => Promise<void>
  cwd: string
  connection: () => Connection
  snapshot: () => Promise<Snapshot>
  getActiveSession: () => { sessionFile?: string; sessionId?: string }
  newSession: () => Promise<SessionSelectionResult>
  switchSession: (path: string) => Promise<SessionSelectionResult>
  editAndPrompt: (
    sessionKey: string,
    entryId: string,
    message: string,
    images?: PiImage[],
    skills?: SkillReference[],
    options?: EditMessageOptions,
  ) => Promise<EditMessageResult>
  forkReply: (sessionKey: string, userTimestamp: number) => Promise<SessionSelectionResult>
  idle: <T>(action: () => Promise<T>, allowDisconnected?: boolean) => Promise<T>
  prompt: (
    sessionKey: string,
    message: string,
    images?: PiImage[],
    skills?: SkillReference[],
    options?: MessageOptions,
  ) => Promise<void>
  steer: (
    sessionKey: string,
    message: string,
    images?: PiImage[],
    skills?: SkillReference[],
    options?: MessageOptions,
  ) => Promise<void>
  followUp: (
    sessionKey: string,
    message: string,
    images?: PiImage[],
    skills?: SkillReference[],
    options?: MessageOptions,
  ) => Promise<void>
  setSessionMode: (sessionKey: string, mode: TaskMode) => Promise<void>
  abort: (sessionKey: string) => Promise<void>
  stopTask: (sessionKey: string) => Promise<void>
  continueStopped: (
    sessionKey: string,
    configuration?: import('@pi-meme/contracts/plan').MessageConfiguration,
  ) => Promise<void>
  pause: (sessionKey: string) => Promise<void>
  resume: (sessionKey: string) => Promise<void>
  recover: (sessionKey: string, failureEntryId: string) => Promise<void>
  steerQueueInput: (sessionKey: string, id: string) => Promise<void>
  deleteQueueInput: (sessionKey: string, id: string) => Promise<void>
  beginQueueEdit: (sessionKey: string, id: string) => Promise<QueuedInput>
  updateQueueInput: (
    sessionKey: string,
    id: string,
    message: string,
    images?: PiImage[],
    skills?: SkillReference[],
    options?: MessageOptions,
  ) => Promise<void>
  cancelQueueEdit: (sessionKey: string, id: string) => Promise<void>
  clearQueue: (sessionKey: string) => Promise<PiQueuedMessages>
  setSteeringMode: (sessionKey: string, mode: 'all' | 'one-at-a-time') => Promise<PiState>
  setFollowUpMode: (sessionKey: string, mode: 'all' | 'one-at-a-time') => Promise<PiState>
  setAccessMode: (sessionKey: string, mode: AgentAccessMode) => Promise<void>
  getCommands: () => Promise<PiSlashCommand[]>
  setModel: (sessionKey: string, model: PiModel) => Promise<PiModel>
  setThinkingLevel: (sessionKey: string, level: ThinkingLevel) => Promise<void>
  getAvailableThinkingLevels: () => Promise<ThinkingLevel[]>
  getSessionStats: () => Promise<import('@pi-meme/contracts/pi').PiSessionStats>
  captureRestoreState: () => Promise<ModelRestore | undefined>
  reconnectModels: (restore?: ModelRestore) => Promise<void>
  respondExtensionUI: (
    sessionKey: string,
    id: string,
    response: import('@pi-meme/contracts/pi').PiExtensionUIResponse,
  ) => Promise<void>
}
