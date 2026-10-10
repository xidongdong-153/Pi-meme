import type { McpBridge } from './mcp'
import type { UsageStatsSnapshot } from './usage'
import type { AgentAccessEvent, AgentAccessMode } from './agent-access'
import type {
  DiscoverModels,
  ConfiguredModel,
  ModelConfigSnapshot,
  SaveModelProvider,
  ModelConfigResult,
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
import type { DesktopProject, SelectWorkspace, WorkspaceKind, PiSessionsSnapshot, SessionHistoryData } from './sessions'
import type {
  AppearanceSettings,
  DesktopSettings,
  InstalledFont,
  InstructionsSnapshot,
  SaveInstruction,
  SaveInstructionResult,
  SettingsSnapshot,
  SubagentCatalogSnapshot,
  Theme,
} from './settings'

export type Connection = {
  workspaceKind?: WorkspaceKind
  generation: number
  sessionKey?: string
  sessionFile?: string
  cwd: string
  status: 'idle' | 'connecting' | 'ready' | 'disconnected'
  error?: string
  accessMode?: AgentAccessMode
  accessChanging?: boolean
  restrictedAccessSupported?: boolean
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
export type ProjectFile = { path: string; kind: 'file' | 'directory' }
export type ProjectApp = { id: 'finder' | 'vscode' | 'cursor' | 'zed'; name: string }
export type DesktopEvent = {
  generation: number
  sessionKey?: string
  sequence?: number
  event: PiEvent | PiExtensionEvent | AgentAccessEvent
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
  getConnection: () => Promise<Connection>
  getSnapshot: () => Promise<Snapshot>
  onEvent: (callback: (event: DesktopEvent) => void) => () => void
  onConnection: (callback: (connection: Connection) => void) => () => void
  onError: (callback: (error: DesktopError) => void) => () => void
}

/** 平台操作：目录选择、Finder 与编辑器启动。 */
export interface PlatformBridge {
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
  prefetchSession: (sessionPath: string) => Promise<void>
  togglePin: (targetPath: string) => Promise<string[]>
}

/** 对话发送、队列、命令与中止。 */
export interface ChatBridge {
  prompt: (sessionKey: string, message: string, images?: PiImage[], skills?: SkillReference[]) => Promise<void>
  steer: (sessionKey: string, message: string, images?: PiImage[], skills?: SkillReference[]) => Promise<void>
  followUp: (sessionKey: string, message: string, images?: PiImage[], skills?: SkillReference[]) => Promise<void>
  clearQueue: (sessionKey: string) => Promise<PiQueuedMessages>
  setSteeringMode: (sessionKey: string, mode: PiState['steeringMode']) => Promise<PiState>
  setFollowUpMode: (sessionKey: string, mode: PiState['followUpMode']) => Promise<PiState>
  setAccessMode: (sessionKey: string, mode: AgentAccessMode) => Promise<void>
  getProjectFiles: (cwd: string, query: string) => Promise<ProjectFile[]>
  getCommands: () => Promise<PiSlashCommand[]>
  abort: (sessionKey: string) => Promise<void>
  editAndPrompt: (
    sessionKey: string,
    timestamp: number,
    message: string,
    images?: PiImage[],
    skills?: SkillReference[],
  ) => Promise<void>
  switchMessageVersion: (sessionKey: string, timestamp: number, version: number) => Promise<boolean>
  forkReply: (sessionKey: string, userTimestamp: number) => Promise<SessionSelectionResult>
}

/** Pi 扩展交互响应。 */
export interface ExtensionBridge {
  respondExtensionUI: (sessionKey: string, id: string, response: PiExtensionUIResponse) => Promise<void>
}

/** Git 状态与文件 Diff。 */
export interface GitBridge {
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
  saveModelProvider: (input: SaveModelProvider) => Promise<ModelConfigResult>
  deleteModelProvider: (id: string, revision: string) => Promise<ModelConfigResult>
  discoverModels: (input: DiscoverModels) => Promise<ConfiguredModel[]>
  reconnectModels: () => Promise<void>
}

/** 桌面设置与主题。 */
export interface SettingsBridge {
  getInstructions: () => Promise<InstructionsSnapshot>
  saveInstruction: (input: SaveInstruction) => Promise<SaveInstructionResult>
  getUsageStats: () => Promise<UsageStatsSnapshot>
  getSettings: () => Promise<SettingsSnapshot>
  getSubagents: () => Promise<SubagentCatalogSnapshot>
  reloadSubagents: () => Promise<SubagentCatalogSnapshot>
  saveSettings: (settings: DesktopSettings) => Promise<SettingsSnapshot>
  saveAppearance: (appearance: AppearanceSettings) => Promise<SettingsSnapshot>
  getInstalledFonts: () => Promise<InstalledFont[]>
  importTheme: () => Promise<SettingsSnapshot | null>
  exportTheme: (theme: Theme) => Promise<void>
  selectTheme: (id: string) => Promise<SettingsSnapshot>
  reloadThemes: () => Promise<SettingsSnapshot>
  openThemesDirectory: () => Promise<void>
  openExtensionsDirectory: () => Promise<void>
}

export type DesktopBridge = ConnectionBridge &
  PlatformBridge &
  WorkspaceBridge &
  ChatBridge &
  ExtensionBridge &
  GitBridge &
  ModelsBridge &
  SettingsBridge &
  McpBridge
