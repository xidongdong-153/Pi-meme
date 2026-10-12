import type { AgentAccessMode } from './agent-access'

export type InstructionKind = 'agents' | 'append-system' | 'system'
export type InstructionFile = {
  path: string
  exists: boolean
  content: string
  revision: string
}
export type InstructionEntry = {
  kind: InstructionKind
  host: InstructionFile
  project: InstructionFile | null
  effective: 'host' | 'project' | 'combined' | 'default'
}
export type InstructionsSnapshot = { entries: InstructionEntry[]; cwd: string }
export type SaveInstruction = { kind: InstructionKind; content: string | null; revision: string }
export type SaveInstructionResult = { snapshot: InstructionsSnapshot; reloadError?: string }

export type ThemeColors = {
  background: string
  surface: string
  elevated: string
  text: string
  muted: string
  border: string
  accent: string
  accentText: string
  success: string
  error: string
}
export type Theme = {
  id: string
  name: string
  appearance: 'dark' | 'light'
  colors: ThemeColors
  fonts: { ui: string; code: string; content?: string }
  fontStyles?: Partial<Record<FontRole, FontStyle>>
}
export type ToolExecutionSettings = { codemodeEnabled: boolean; mcpEnabled: boolean }

export type SubagentCatalogEntry = {
  id: string
  description: string
  tools: string[]
  maxTurns: number
  enabled: boolean
}
export type SubagentDiagnostic = { path: string; message: string }
export type SubagentCatalogSnapshot = {
  directory: string
  agents: SubagentCatalogEntry[]
  diagnostics: SubagentDiagnostic[]
}

export type SidebarPreferences = {
  groupMode: 'projects' | 'merged'
  sortMode: 'recent' | 'manual'
  collapsed: { pinned: boolean; projects: boolean; recents: boolean }
  orders: Record<string, string[]>
}
export type SidebarPreferencesPatch = {
  groupMode?: SidebarPreferences['groupMode']
  sortMode?: SidebarPreferences['sortMode']
  collapsed?: Partial<SidebarPreferences['collapsed']>
  orders?: SidebarPreferences['orders']
}

export type DesktopSettings = {
  sidebar?: SidebarPreferences
  codemodeEnabled?: boolean
  mcpEnabled?: boolean
  subagentsEnabled?: boolean
  enabledSubagents?: string[]
  appearance?: AppearanceSettings
  themeId: string
  pinnedPaths?: string[]
  preferredProjectApp?: 'finder' | 'vscode' | 'cursor' | 'zed'
  defaultAccessMode?: AgentAccessMode
}
export type SettingsSnapshot = {
  settings: DesktopSettings
  themes: Theme[]
  themesDirectory: string
  extensionsDirectory: string
  errors: string[]
}

export type AppearanceMode = 'system' | 'light' | 'dark'
export type FontRole = 'ui' | 'content' | 'code'
export type FontStyle = 'regular' | 'bold' | 'italic' | 'bold-italic'
export type AppearanceOverrides = {
  colors?: Partial<Pick<ThemeColors, 'background' | 'text' | 'accent'>>
  fonts?: Partial<Record<FontRole, string>>
  fontStyles?: Partial<Record<FontRole, FontStyle>>
}
export type AppearanceSettings = {
  mode: AppearanceMode
  lightThemeId: string
  darkThemeId: string
  separate: boolean
  shared: AppearanceOverrides
  light?: AppearanceOverrides
  dark?: AppearanceOverrides
  uiSize: number
  codeSize: number
  reducedMotion: 'system' | 'on' | 'off'
  translucentSidebar: boolean
  contrast: number
}
export type InstalledFont = { family: string; styles: FontStyle[] }
