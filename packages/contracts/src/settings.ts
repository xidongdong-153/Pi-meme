import type { PiModel, ThinkingLevel } from './pi'
import type { AgentAccessMode } from './agent-access'
import type { ProjectApp } from './desktop'

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
  tokens?: ThemeTokens
  background?: ThemeBackground
  plugin?: { id: string; generation: number }
}
export type ThemeTokens = { spacing: number; radius: number; surfaceOpacity: number }
export type ThemeBackground = {
  image: string
  area: 'app' | 'workspace' | 'sidebar'
  fit: 'cover' | 'contain'
  position: 'center' | 'top' | 'bottom'
  opacity: number
  overlay: string
  blur: number
  /** 由 Host 生成的认证资源地址，不从主题文件读取。 */
  url?: string
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

export type SubagentDefaults = {
  model: Pick<PiModel, 'provider' | 'id'> | null
  thinkingLevel: ThinkingLevel | null
}
export type SubagentDefaultsPatch = Partial<SubagentDefaults>

export type DesktopSettings = {
  subagentDefaults?: SubagentDefaults
  defaultAgentPlugins?: string[]
  sidebar?: SidebarPreferences
  codemodeEnabled?: boolean
  mcpEnabled?: boolean
  subagentsEnabled?: boolean
  enabledSubagents?: string[]
  appearance?: AppearanceSettings
  appearanceStorage?: { version: 1; legacyImport: 'eligible' | 'complete' }
  themeId: string
  pinnedPaths?: string[]
  preferredProjectApp?: ProjectApp['id']
  defaultAccessMode?: AgentAccessMode
  showComposerHint?: boolean
  showContextUsage?: boolean
}
export type SettingsSnapshot = {
  settings: DesktopSettings
  appearanceRevision: string
  writeState: { status: 'ready' | 'blocked'; error?: string }
  legacyAppearanceImport: 'eligible' | 'complete'
  themes: Theme[]
  themesDirectory: string
  errors: string[]
}

export type AppearanceMode = 'system' | 'light' | 'dark'
export type FontRole = 'ui' | 'content' | 'code'
export type FontStyle = 'regular' | 'bold' | 'italic' | 'bold-italic'
export type AppearanceOverrides = {
  colors?: Partial<Pick<ThemeColors, 'background' | 'text' | 'accent'>>
  fonts?: Partial<Record<FontRole, string>>
  fontStyles?: Partial<Record<FontRole, FontStyle>>
  tokens?: Partial<ThemeTokens>
  background?: Partial<Pick<ThemeBackground, 'opacity' | 'blur'>>
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
type OverridePatch<T> = { [K in keyof T]?: T[K] | null }
export type AppearanceOverridesPatch = {
  colors?: OverridePatch<NonNullable<AppearanceOverrides['colors']>>
  fonts?: OverridePatch<NonNullable<AppearanceOverrides['fonts']>>
  fontStyles?: OverridePatch<NonNullable<AppearanceOverrides['fontStyles']>>
  tokens?: OverridePatch<NonNullable<AppearanceOverrides['tokens']>>
  background?: OverridePatch<NonNullable<AppearanceOverrides['background']>>
}
export type AppearancePatch = Partial<
  Pick<AppearanceSettings, 'mode' | 'uiSize' | 'codeSize' | 'reducedMotion' | 'translucentSidebar' | 'contrast'>
> & {
  shared?: AppearanceOverridesPatch
  light?: AppearanceOverridesPatch
  dark?: AppearanceOverridesPatch
}
export type AppearanceOperation =
  | { type: 'patch'; patch: AppearancePatch }
  | { type: 'select-theme'; themeId: string }
  | { type: 'separate'; separate: boolean; mode: 'light' | 'dark' }
  | { type: 'reset' }
export type AppearanceUpdate = { expectedRevision: string; operation: AppearanceOperation }
export type AppearanceSaveResult = { status: 'saved' | 'conflict'; snapshot: SettingsSnapshot }
export type AppearanceMigration = { expectedRevision: string; appearance: AppearanceSettings }
export type AppearanceMigrationResult = {
  status: 'applied' | 'already-migrated' | 'host-authoritative' | 'conflict'
  snapshot: SettingsSnapshot
}
export type RuntimeSettingsPatch = Omit<DesktopSettings, 'appearance' | 'appearanceStorage' | 'themeId'>
export type InstalledFont = { family: string; styles: FontStyle[]; monospace: boolean }
