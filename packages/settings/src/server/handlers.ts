import type { PiRuntime } from '@pi-meme/pi-runtime/runtime'
import { getInstalledFonts } from './fonts'
import { parseTheme } from '../shared/themes'
import { text } from '@pi-meme/contracts/ipc'
import { defaultAccessMode } from '@pi-meme/contracts/agent-access'
import type { SettingsStore } from './store'
import type { DesktopSettings, SubagentCatalogSnapshot } from '@pi-meme/contracts/settings'
import { parseSaveInstruction, type InstructionsStore } from './instructions'

export type SettingsHandlerContext = {
  pi: PiRuntime
  instructions?: InstructionsStore
  openPath?: (directory: string) => Promise<string>
  settings: SettingsStore
  chooseImport?: () => Promise<string | null>
  chooseExport?: (name: string) => Promise<string | null>
  getSubagents?: () => Promise<SubagentCatalogSnapshot>
  configureOptionalExtensions?: (settings: DesktopSettings) => Promise<SubagentCatalogSnapshot>
}

export function createSettingsHandlers({
  pi,
  instructions,
  openPath,
  settings,
  chooseImport,
  chooseExport,
  configureOptionalExtensions,
}: SettingsHandlerContext) {
  return {
    'settings:instructions': () => {
      if (!instructions) throw new Error('当前 Host 未配置指令目录')
      return instructions.snapshot(pi.cwd)
    },
    'settings:save-instruction': (value: unknown) =>
      pi.idle(async () => {
        if (!instructions) throw new Error('当前 Host 未配置指令目录')
        const input = parseSaveInstruction(value)
        const cwd = pi.cwd
        const restore = await pi.captureRestoreState()
        await instructions.save(input)
        let reloadError: string | undefined
        try {
          await pi.reconnectModels(restore)
        } catch (cause) {
          reloadError = `指令已保存，重载失败：${String(cause)}。请点击重新加载。`
        }
        return { snapshot: await instructions.snapshot(cwd), reloadError }
      }, true),
    'settings:toggle-pin': (value: unknown) => {
      text(value)
      return settings.togglePin(value)
    },
    'settings:appearance': (value: unknown) => settings.saveAppearance(value),
    'settings:editor': (value: unknown) => settings.saveEditorSettings(value),
    'settings:sidebar': (value: unknown) => settings.saveSidebarPreferences(value),
    'settings:fonts': () => getInstalledFonts(),
    'settings:import-theme': async () => {
      const filename = await chooseImport?.()
      return filename ? settings.importTheme(filename) : null
    },
    'settings:export-theme': async (value: unknown) => {
      const theme = parseTheme(value)
      const filename = await chooseExport?.(theme.id)
      if (filename) await settings.exportTheme(filename, theme)
    },
    'settings:get': () => settings.snapshot(),
    'settings:save-user-profile': (value: unknown) => {
      const input = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
      return settings.saveUserProfile({
        name: typeof input.name === 'string' ? input.name : undefined,
        username: typeof input.username === 'string' ? input.username : undefined,
        email: typeof input.email === 'string' ? input.email : undefined,
        avatarData: typeof input.avatarData === 'string' ? input.avatarData : undefined,
        avatarText: typeof input.avatarText === 'string' ? input.avatarText : undefined,
      })
    },
    'settings:get-user-profile': () => settings.getUserProfile(),
    'settings:save': (value: unknown) =>
      pi.idle(async () => {
        const previous = settings.snapshot().settings
        const snapshot = await settings.save(value)
        const optionalExtensionsChanged =
          previous.subagentsEnabled !== snapshot.settings.subagentsEnabled ||
          JSON.stringify(previous.enabledSubagents ?? []) !== JSON.stringify(snapshot.settings.enabledSubagents ?? [])
        if (optionalExtensionsChanged) await configureOptionalExtensions?.(snapshot.settings)
        if (previous.defaultAccessMode !== snapshot.settings.defaultAccessMode)
          await pi.configureDefaultAccessMode(snapshot.settings.defaultAccessMode ?? defaultAccessMode)
        const changed =
          previous.codemodeEnabled !== snapshot.settings.codemodeEnabled ||
          previous.mcpEnabled !== snapshot.settings.mcpEnabled ||
          optionalExtensionsChanged
        if (changed || pi.connection().status === 'disconnected' || pi.connection().error) {
          pi.configureCapabilities({
            codemodeEnabled: Boolean(snapshot.settings.codemodeEnabled),
            mcpEnabled: Boolean(snapshot.settings.mcpEnabled),
          })
          try {
            await pi.reconnectModels()
          } catch (cause) {
            throw new Error(`配置已保存，Pi 重连失败：${String(cause)}`)
          }
        }
        return snapshot
      }, true),
    'settings:theme': (id: unknown) => {
      text(id)
      return settings.selectTheme(id)
    },
    'settings:reload-themes': () => settings.reloadThemes(),
    'settings:open-themes': async () => {
      const error = await (openPath?.(settings.themesDirectory) ??
        Promise.reject(new Error('当前客户端不能打开 Host 目录')))
      if (error) throw new Error(`无法打开主题目录：${error}`)
    },
  }
}
