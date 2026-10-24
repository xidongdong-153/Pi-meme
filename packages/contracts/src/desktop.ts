import type { Goal, GoalControl, GoalEdit, GoalEvent, GoalInput, GoalResumeControl, GoalStartResult } from './goal'
import type { AppSession } from './app-host'
import type { ChatBranchAttachment, ChatFileUpload, ChatUploadedFile } from './chat-attachments'
import type { DesktopStorageAdapter, HostStorageInfo } from './storage'
import type { McpBridge } from './mcp'
import type {
  AgentMailboxMessage,
  AgentSummary,
  CollaborationBridge,
  CollaborationEvent,
  PendingInteraction,
} from './collaboration'
import type {
  MessageOptions,
  MessageConfiguration,
  QueuedInput,
  PlanDocument,
  PlanEvent,
  TaskMode,
  EditMessageOptions,
  EditMessageResult,
} from './plan'
import type { UsageStatsSnapshot } from './usage'
import type { AgentAccessEvent, AgentAccessMode } from './agent-access'
import type {
  DiscoverModels,
  ConfiguredModel,
  ModelConfigSnapshot,
  SaveModelProvider,
  ModelConfigResult,
  BuiltinProviderInfo,
  ModelLoginState,
  StartBuiltinLogin,
  RespondBuiltinLogin,
  BuiltinLogoutResult,
} from './model-config'
import type { SkillReference } from './skills'
import type {
  PiEvent,
  PiSessionEntries,
  PiExtensionEvent,
  PiExtensionUIResponse,
  PiImage,
  PiMessage,
  PiModel,
  PiSlashCommand,
  PiState,
  PiQueuedMessages,
  ThinkingLevel,
  PiSessionStats,
} from './pi'
import type {
  DesktopProject,
  SelectWorkspace,
  WorkspaceKind,
  PiSessionsSnapshot,
  SessionHistoryData,
  SessionSearchMatch,
} from './sessions'
import type {
  AppearanceSettings,
  DesktopSettings,
  InstalledFont,
  InstructionsSnapshot,
  SaveInstruction,
  SaveInstructionResult,
  SettingsSnapshot,
  SidebarPreferences,
  SidebarPreferencesPatch,
  SubagentCatalogSnapshot,
  SubagentDefaults,
  SubagentDefaultsPatch,
  Theme,
} from './settings'

export type Connection = {
  workspaceKind?: WorkspaceKind
  sourceProjectCwd?: string
  generation: number
  sessionKey?: string
  sessionFile?: string
  cwd: string
  status: 'idle' | 'connecting' | 'ready' | 'disconnected'
  error?: string
  accessMode?: AgentAccessMode
  accessChanging?: boolean
  editPhase?: 'stopping' | 'sending'
  restrictedAccessSupported?: boolean
  restrictedAccessReason?: string
  restrictedPluginRuntimeSupported?: boolean
  restrictedPluginRuntimeReason?: string
  /** 内置 Pi 运行时版本，由应用随包分发。 */
  piVersion?: string
}
export type GitFileChange = { path: string; status: string; kind: 'staged' | 'unstaged' | 'untracked' }
export type GitSnapshot = {
  cwd: string
  root?: string
  branch?: string
  files: GitFileChange[]
  insertions: number
  deletions: number
  error?: 'unavailable' | 'not-repository' | 'failed'
}
export type GitBranch = { name: string; ref: string; kind: 'local' | 'remote'; current: boolean; occupiedBy?: string }
export type GitEnvironment = {
  cwd: string
  root: string
  branch?: string
  headSha?: string
  dirty: boolean
  branches: GitBranch[]
}
export type GitWorktreeResult = {
  cwd: string
  checkoutRoot: string
  sourceProjectCwd: string
  baseRef: string
  headSha: string
  selection: SessionSelectionResult
  selectionError?: string
}
export type ProjectFile = { path: string; kind: 'file' | 'directory' }
export const projectAppIds = [
  'finder',
  'vscode',
  'cursor',
  'zed',
  'windsurf',
  'sublime-text',
  'intellij-idea',
  'webstorm',
  'pycharm',
  'goland',
  'phpstorm',
  'rubymine',
  'clion',
  'rider',
  'rustrover',
] as const
export type ProjectApp = { id: (typeof projectAppIds)[number]; name: string }
export type DesktopEvent = {
  generation: number
  sessionKey?: string
  sequence?: number
  executionGeneration?: number
  rootAgentId?: string
  agentId?: string
  runId?: string
  event: PiEvent | PiExtensionEvent | AgentAccessEvent | CollaborationEvent | PlanEvent | GoalEvent
}
export type DesktopError = {
  generation: number
  sessionKey?: string
  message: string
  extension?: { path: string; event: string }
}
export type SessionPluginDescriptor = {
  id: string
  version: string
  generation: number
  ui?: string
  enabled: boolean
  status: 'active' | 'disabled' | 'pending' | 'failed'
  error?: string
}
export type Snapshot = {
  agent?: AgentSummary
  agents?: AgentSummary[]
  goal?: Goal
  goalsSupported?: boolean
  planDocuments?: PlanDocument[]
  pendingInteractions?: PendingInteraction[]
  agentMessages?: AgentMailboxMessage[]
  uiPlugins?: SessionPluginDescriptor[]
  extensionError?: DesktopError
  connection: Connection
  state: PiState
  messages: PiMessage[]
  models: PiModel[]
  thinkingLevels?: ThinkingLevel[]
  stats?: PiSessionStats
  events?: DesktopEvent[]
  eventSequence?: number
  sessionEntries?: PiSessionEntries
  branchAttachments?: ChatBranchAttachment[]
}

export type SessionSelectionResult =
  { cancelled: false; snapshot: Snapshot; commands?: PiSlashCommand[] } | { cancelled: true }

export type WorkspaceDeletionResult = {
  deletedPaths: string[]
  deletedKeys: string[]
  warnings?: string[]
  errors: string[]
  selection?: SessionSelectionResult
}

/** 连接、快照与桌面事件订阅。renderer 只保留这一组底层订阅。 */
export interface ConnectionBridge {
  resolveAppSession: (sessionKey: string) => Promise<AppSession>
  getConnection: () => Promise<Connection>
  getSnapshot: () => Promise<Snapshot>
  onEvent: (callback: (event: DesktopEvent) => void) => () => void
  onConnection: (callback: (connection: Connection) => void) => () => void
  onError: (callback: (error: DesktopError) => void) => () => void
}

/** 平台操作：目录选择、Finder 与编辑器启动。 */
export interface PlatformBridge {
  pickProjectDirectory: () => Promise<string | null>
  addProjectDirectory: () => Promise<DesktopProject | null>
  chooseDirectory: (targetPath?: string) => Promise<string | null>
  getProjectApps: () => Promise<ProjectApp[]>
  openProject: (app: ProjectApp['id'], cwd?: string) => Promise<void>
  setPreferredProjectApp: (app: ProjectApp['id']) => Promise<void>
}

/** 会话列表、历史读取、切换与置顶。 */
export interface WorkspaceBridge {
  renameProject: (cwd: string, name: string) => Promise<void>
  previewProjectDeletion: (cwd: string) => Promise<{ paths: string[]; warnings: string[] }>
  removeProject: (cwd: string, expectedPaths: string[]) => Promise<WorkspaceDeletionResult>
  renameSession: (path: string, name: string) => Promise<void>
  deleteSession: (path: string) => Promise<WorkspaceDeletionResult>
  getProjects: () => Promise<DesktopProject[]>
  selectWorkspace: (input: SelectWorkspace) => Promise<SessionSelectionResult>
  getSessions: () => Promise<PiSessionsSnapshot>
  onSessionsChanged: (callback: () => void) => () => void
  newSession: () => Promise<SessionSelectionResult>
  switchSession: (sessionPath: string) => Promise<SessionSelectionResult>
  readSessionHistory: (sessionPath: string) => Promise<SessionHistoryData>
  searchSessions: (query: string, paths: string[]) => Promise<SessionSearchMatch[]>
  prefetchSession: (sessionPath: string) => Promise<void>
  togglePin: (targetPath: string) => Promise<string[]>
}

/** 对话发送、队列、命令与中止。 */
export interface ChatBridge {
  uploadAttachment: (
    sessionKey: string,
    input: ChatFileUpload,
    signal?: AbortSignal,
    onProgress?: (percent: number) => void,
  ) => Promise<ChatUploadedFile>
  startGoal?: (key: string, input: GoalInput) => Promise<GoalStartResult>
  editGoal?: (key: string, input: GoalEdit) => Promise<Goal>
  pauseGoal?: (key: string, input: GoalControl) => Promise<Goal>
  resumeGoal?: (key: string, input: GoalResumeControl) => Promise<Goal>
  clearGoal?: (key: string, input: GoalControl) => Promise<void>
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
  pause: (sessionKey: string) => Promise<void>
  resume: (sessionKey: string) => Promise<void>
  stopTask: (sessionKey: string) => Promise<void>
  continueStopped: (sessionKey: string, configuration?: MessageConfiguration) => Promise<void>
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
  setSteeringMode: (sessionKey: string, mode: PiState['steeringMode']) => Promise<PiState>
  setFollowUpMode: (sessionKey: string, mode: PiState['followUpMode']) => Promise<PiState>
  setAccessMode: (sessionKey: string, mode: AgentAccessMode) => Promise<void>
  getProjectFiles: (cwd: string, query: string) => Promise<ProjectFile[]>
  getCommands: () => Promise<PiSlashCommand[]>
  abort: (sessionKey: string) => Promise<void>
  editAndPrompt: (
    sessionKey: string,
    entryId: string,
    message: string,
    images?: PiImage[],
    skills?: SkillReference[],
    options?: EditMessageOptions,
  ) => Promise<EditMessageResult>
  forkReply: (sessionKey: string, userTimestamp: number) => Promise<SessionSelectionResult>
}

/** Pi 扩展交互响应。 */
export interface ExtensionBridge {
  respondExtensionUI: (sessionKey: string, id: string, response: PiExtensionUIResponse) => Promise<void>
}

/** Git 状态与文件 Diff。 */
export interface GitBridge {
  getGitEnvironment: (sessionKey: string) => Promise<GitEnvironment>
  switchGitBranch: (sessionKey: string, branch: string) => Promise<SessionSelectionResult>
  createGitBranch: (sessionKey: string, branch: string, baseRef: string) => Promise<SessionSelectionResult>
  createGitWorktree: (sessionKey: string, baseRef: string) => Promise<GitWorktreeResult>
  getGitSnapshot: () => Promise<GitSnapshot>
  getGitDiff: (filePath: string, kind: GitFileChange['kind']) => Promise<string>
}

/** 模型、思考等级、上下文占用与模型配置。 */
export interface ModelsBridge {
  setModel: (sessionKey: string, model: PiModel) => Promise<PiModel>
  setThinkingLevel: (sessionKey: string, level: ThinkingLevel) => Promise<void>
  getAvailableThinkingLevels: () => Promise<ThinkingLevel[]>
  getSessionStats: () => Promise<PiSessionStats>
  getModelConfig: () => Promise<ModelConfigSnapshot>
  getDefaultModel: () => Promise<PiModel | null>
  setDefaultModel: (model: PiModel) => Promise<void>
  getDefaultThinkingLevel: () => Promise<ThinkingLevel | null>
  setDefaultThinkingLevel: (level: ThinkingLevel) => Promise<void>
  saveModelProvider: (input: SaveModelProvider) => Promise<ModelConfigResult>
  deleteModelProvider: (id: string, revision: string) => Promise<ModelConfigResult>
  discoverModels: (input: DiscoverModels) => Promise<ConfiguredModel[]>
  reconnectModels: () => Promise<void>
  listBuiltinProviders: () => Promise<BuiltinProviderInfo[]>
  startBuiltinLogin: (input: StartBuiltinLogin) => Promise<ModelLoginState>
  getBuiltinLogin: () => Promise<ModelLoginState | null>
  respondBuiltinLogin: (input: RespondBuiltinLogin) => Promise<ModelLoginState>
  cancelBuiltinLogin: () => Promise<ModelLoginState | null>
  logoutBuiltinProvider: (providerId: string) => Promise<BuiltinLogoutResult>
}

/** 桌面设置与主题。 */
export interface SettingsBridge {
  getStorageInfo: () => Promise<HostStorageInfo>
  storage?: DesktopStorageAdapter
  getInstructions: () => Promise<InstructionsSnapshot>
  saveInstruction: (input: SaveInstruction) => Promise<SaveInstructionResult>
  getUsageStats: () => Promise<UsageStatsSnapshot>
  getSettings: () => Promise<SettingsSnapshot>
  getSubagents: () => Promise<SubagentCatalogSnapshot>
  reloadSubagents: () => Promise<SubagentCatalogSnapshot>
  saveSettings: (settings: DesktopSettings) => Promise<SettingsSnapshot>
  saveSubagentDefaults: (patch: SubagentDefaultsPatch) => Promise<SubagentDefaults>
  saveEditorSettings: (
    settings: Pick<DesktopSettings, 'showComposerHint' | 'showContextUsage'>,
  ) => Promise<SettingsSnapshot>
  saveSidebarPreferences: (patch: SidebarPreferencesPatch) => Promise<SidebarPreferences>
  saveAppearance: (appearance: AppearanceSettings) => Promise<SettingsSnapshot>
  getInstalledFonts: () => Promise<InstalledFont[]>
  importTheme: () => Promise<SettingsSnapshot | null>
  exportTheme: (theme: Theme) => Promise<void>
  selectTheme: (id: string) => Promise<SettingsSnapshot>
  reloadThemes: () => Promise<SettingsSnapshot>
  openThemesDirectory: () => Promise<void>
  getUserProfile?: () => Promise<{
    name: string
    username: string
    email: string
    avatarText?: string
    avatarUrl?: string
  }>
  saveUserProfile?: (profile: {
    name?: string
    username?: string
    email?: string
    avatarData?: string
    avatarText?: string
  }) => Promise<{ name: string; username: string; email: string; avatarUrl?: string }>
}

export type DesktopBridge = ConnectionBridge &
  PlatformBridge &
  WorkspaceBridge &
  ChatBridge &
  ExtensionBridge &
  GitBridge &
  ModelsBridge &
  SettingsBridge &
  CollaborationBridge &
  McpBridge
