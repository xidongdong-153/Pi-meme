import { mkdir, readFile, readdir, writeFile, rename } from 'node:fs/promises'
import path from 'node:path'
import { isAgentAccessMode } from '@pi-meme/contracts/agent-access'
import type { AppearanceSettings, DesktopSettings, SettingsSnapshot, Theme } from '@pi-meme/contracts/settings'
import { defaultAppearance, migrateAppearance, selectAppearanceTheme, validateAppearance } from '../shared/appearance'
import { builtinThemes, parseTheme } from '../shared/themes'
import { defaultSidebarPreferences, parseSidebarPreferencesPatch, validateSidebarPreferences } from '../shared/sidebar'
import { DEFAULT_USER_PROFILE } from '../shared/user-profile'

function normalizeEnabledSubagents(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 16 ||
    value.some((entry) => typeof entry !== 'string' || entry.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry))
  )
    throw new Error('子 Agent 启用列表无效')
  return [...new Set(value as string[])].sort()
}

export class SettingsStore {
  settings: DesktopSettings = {
    themeId: 'dark',
    codemodeEnabled: true,
    mcpEnabled: true,
    subagentsEnabled: true,
    enabledSubagents: [],
    appearance: defaultAppearance(),
    sidebar: defaultSidebarPreferences(),
  }
  private writes: Promise<unknown> = Promise.resolve()
  private themes = [...builtinThemes]
  private errors: string[] = []
  readonly themesDirectory: string
  readonly profileDirectory: string
  private pluginThemes: Theme[] = []
  private readonly settingsFile: string
  constructor(directory: string) {
    this.themesDirectory = path.join(directory, 'themes')
    this.profileDirectory = path.join(directory, 'profile')
    this.settingsFile = path.join(directory, 'settings.json')
  }

  async saveUserProfile(profile: {
    name?: string
    username?: string
    email?: string
    avatarData?: string
    avatarText?: string
  }) {
    await mkdir(this.profileDirectory, { recursive: true })
    const profileFile = path.join(this.profileDirectory, 'profile.json')
    let current: Partial<typeof DEFAULT_USER_PROFILE> & { avatarFile?: string } = {}
    try {
      current = JSON.parse(await readFile(profileFile, 'utf8')) as typeof current
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    }

    let avatarFileName = typeof current.avatarFile === 'string' ? current.avatarFile : 'avatar.png'
    if (profile.avatarData && typeof profile.avatarData === 'string') {
      const match = profile.avatarData.match(/^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/)
      if (match) {
        const ext = match[1] === 'jpeg' ? 'jpg' : match[1]
        avatarFileName = `avatar.${ext}`
        const buffer = Buffer.from(match[2], 'base64')
        await writeFile(path.join(this.profileDirectory, avatarFileName), buffer)
      }
    }

    const next = {
      ...current,
      name: (profile.name ?? current.name)?.trim() || DEFAULT_USER_PROFILE.name,
      username: (profile.username ?? current.username)?.trim() || DEFAULT_USER_PROFILE.username,
      email: (profile.email ?? current.email)?.trim() || DEFAULT_USER_PROFILE.email,
      avatarText: (profile.avatarText ?? current.avatarText)?.trim() || DEFAULT_USER_PROFILE.avatarText,
      avatarFile: avatarFileName,
      updatedAt: new Date().toISOString(),
    }
    await writeFile(profileFile, JSON.stringify(next, null, 2), 'utf8')
    return this.getUserProfile()
  }

  async getUserProfile() {
    await mkdir(this.profileDirectory, { recursive: true })
    const profileFile = path.join(this.profileDirectory, 'profile.json')
    let current: {
      name?: string
      username?: string
      email?: string
      avatarText?: string
      avatarFile?: string
    } = {}
    try {
      current = JSON.parse(await readFile(profileFile, 'utf8')) as typeof current
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    }

    let avatarUrl: string | undefined
    if (current.avatarFile) {
      try {
        const avatarPath = path.join(this.profileDirectory, current.avatarFile)
        const buffer = await readFile(avatarPath)
        const ext = path.extname(current.avatarFile).replace('.', '') || 'png'
        const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
        avatarUrl = `data:${mime};base64,${buffer.toString('base64')}`
      } catch {
        // 头像文件不存在则忽略
      }
    }

    return {
      name: current.name?.trim() || DEFAULT_USER_PROFILE.name,
      username: current.username?.trim() || DEFAULT_USER_PROFILE.username,
      email: current.email?.trim() || DEFAULT_USER_PROFILE.email,
      avatarText: current.avatarText?.trim() || DEFAULT_USER_PROFILE.avatarText,
      avatarUrl,
    }
  }

  private pendingPluginSelection?: Pick<DesktopSettings, 'themeId' | 'appearance'>

  async load() {
    await mkdir(this.themesDirectory, { recursive: true })
    try {
      const value: unknown = JSON.parse(await readFile(this.settingsFile, 'utf8'))
      this.validateSettings(value)
      const stored = { ...value } as DesktopSettings & { userExtensionPaths?: unknown }
      delete stored.userExtensionPaths
      this.settings = {
        ...stored,
        codemodeEnabled: Boolean(value.codemodeEnabled || value.mcpEnabled),
        mcpEnabled: Boolean(value.mcpEnabled),
        subagentsEnabled: Boolean(value.subagentsEnabled),
        enabledSubagents: normalizeEnabledSubagents(value.enabledSubagents ?? []),
        sidebar: value.sidebar ?? defaultSidebarPreferences(),
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.errors.push(`无法读取桌面设置：${String(error)}`)
    }
    this.pendingPluginSelection = structuredClone({
      themeId: this.settings.themeId,
      appearance: this.settings.appearance,
    })
    await this.reloadThemes(false)
    this.settings.appearance = migrateAppearance(this.settings, this.themes)
    return this.snapshot()
  }

  private validateSettings(value: unknown): asserts value is DesktopSettings {
    const settings = value as DesktopSettings | null
    if (
      !settings ||
      typeof settings.themeId !== 'string' ||
      (settings.pinnedPaths !== undefined &&
        (!Array.isArray(settings.pinnedPaths) || settings.pinnedPaths.some((entry) => typeof entry !== 'string'))) ||
      (settings.preferredProjectApp !== undefined &&
        !['finder', 'vscode', 'cursor', 'zed'].includes(settings.preferredProjectApp))
    )
      throw new Error('主题 ID 无效')
    if (
      settings.defaultAgentPlugins !== undefined &&
      (!Array.isArray(settings.defaultAgentPlugins) ||
        settings.defaultAgentPlugins.some((id) => typeof id !== 'string' || !id.trim()))
    )
      throw new Error('默认 Agent 插件列表无效')
    for (const key of ['codemodeEnabled', 'mcpEnabled', 'subagentsEnabled'] as const) {
      if (settings[key] !== undefined && typeof settings[key] !== 'boolean') throw new Error('工具执行开关必须是布尔值')
    }
    if (settings.enabledSubagents !== undefined) normalizeEnabledSubagents(settings.enabledSubagents)
    if (settings.appearance !== undefined) validateAppearance(settings.appearance)
    if (settings.sidebar !== undefined) validateSidebarPreferences(settings.sidebar)
    if (settings.defaultAccessMode !== undefined && !isAgentAccessMode(settings.defaultAccessMode))
      throw new Error('Agent 访问权限默认值无效')
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.writes.then(work)
    this.writes = next.catch(() => {})
    return next
  }

  save(value: unknown) {
    return this.enqueue(() => this.saveNow(value))
  }

  saveSidebarPreferences(value: unknown) {
    return this.enqueue(async () => {
      const patch = parseSidebarPreferencesPatch(value)
      const current = this.settings.sidebar ?? defaultSidebarPreferences()
      const sidebar = {
        ...current,
        ...patch,
        collapsed: { ...current.collapsed, ...patch.collapsed },
        orders: { ...current.orders, ...patch.orders },
      }
      await this.saveNow({ ...this.settings, sidebar }, false, true)
      return structuredClone(sidebar)
    })
  }

  saveAppearance(value: unknown) {
    return this.enqueue(async () => {
      validateAppearance(value)
      for (const mode of ['light', 'dark'] as const) {
        if (!this.themes.some((theme) => theme.id === value[`${mode}ThemeId`] && theme.appearance === mode))
          throw new Error('主题不存在或明暗模式不匹配，请重新加载主题列表')
      }
      const appearance: AppearanceSettings = structuredClone(value)
      const themeId = appearance.mode === 'light' ? appearance.lightThemeId : appearance.darkThemeId
      return this.saveNow({ ...this.settings, appearance, themeId }, true)
    })
  }

  selectTheme(id: string) {
    const theme = this.themes.find((entry) => entry.id === id)
    if (!theme) return Promise.reject(new Error('主题不存在，请重新加载主题列表'))
    return this.saveAppearance({
      ...selectAppearanceTheme(migrateAppearance(this.settings, this.themes), theme),
      mode: theme.appearance,
    })
  }

  async importTheme(filename: string) {
    let theme: Theme
    try {
      theme = parseTheme(JSON.parse(await readFile(filename, 'utf8')))
    } catch (cause) {
      throw new Error(`无法导入主题：${String(cause)}`)
    }
    if (theme.background) throw new Error('背景图片必须随 App 插件分发，请安装 .pim 主题插件')
    if (this.themes.some((entry) => entry.id === theme.id)) throw new Error('主题 ID 已存在，请修改 JSON 中的 id')
    await writeFile(path.join(this.themesDirectory, `${theme.id}.json`), `${JSON.stringify(theme, null, 2)}\n`, {
      flag: 'wx',
    })
    return this.reloadThemes()
  }

  async exportTheme(filename: string, value: unknown) {
    const theme = parseTheme(value)
    await writeFile(filename, `${JSON.stringify(theme, null, 2)}\n`, 'utf8')
  }

  private async saveNow(value: unknown, appearanceOnly = false, sidebarOnly = false) {
    this.validateSettings(value)
    if (!this.themes.some((theme) => theme.id === value.themeId)) throw new Error('主题不存在，请重新加载主题列表')
    let appearance = appearanceOnly ? value.appearance : this.settings.appearance
    if (!appearanceOnly && value.appearance === undefined && value.themeId !== this.settings.themeId) {
      const theme = this.themes.find((entry) => entry.id === value.themeId)!
      appearance = {
        ...selectAppearanceTheme(migrateAppearance(this.settings, this.themes), theme),
        mode: theme.appearance,
      }
    }
    const next: DesktopSettings = {
      defaultAgentPlugins: [...new Set(value.defaultAgentPlugins ?? this.settings.defaultAgentPlugins ?? [])],
      sidebar: sidebarOnly ? value.sidebar : (this.settings.sidebar ?? defaultSidebarPreferences()),
      appearance,
      themeId: !appearanceOnly && value.appearance ? this.settings.themeId : value.themeId,
      mcpEnabled: value.mcpEnabled ?? this.settings.mcpEnabled ?? false,
      subagentsEnabled: value.subagentsEnabled ?? this.settings.subagentsEnabled ?? false,
      enabledSubagents: normalizeEnabledSubagents(value.enabledSubagents ?? this.settings.enabledSubagents ?? []),
      codemodeEnabled: Boolean(
        (value.mcpEnabled ?? this.settings.mcpEnabled) || (value.codemodeEnabled ?? this.settings.codemodeEnabled),
      ),
      defaultAccessMode: value.defaultAccessMode ?? this.settings.defaultAccessMode,
      pinnedPaths: Array.isArray(value.pinnedPaths)
        ? value.pinnedPaths.filter((entry): entry is string => typeof entry === 'string')
        : (this.settings.pinnedPaths ?? []),
      preferredProjectApp: value.preferredProjectApp ?? this.settings.preferredProjectApp ?? 'finder',
    }
    await writeFile(`${this.settingsFile}.tmp`, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    await rename(`${this.settingsFile}.tmp`, this.settingsFile)
    this.settings = next
    return this.snapshot()
  }

  removePins(paths: string[]) {
    const removed = new Set(paths)
    return this.enqueue(() =>
      this.saveNow({
        ...this.settings,
        pinnedPaths: (this.settings.pinnedPaths ?? []).filter((item) => !removed.has(item)),
      }),
    )
  }

  togglePin(targetPath: string): Promise<string[]> {
    return this.enqueue(async () => {
      const current = new Set(this.settings.pinnedPaths ?? [])
      if (current.has(targetPath)) current.delete(targetPath)
      else current.add(targetPath)
      const pinnedPaths = Array.from(current)
      await this.saveNow({ ...this.settings, pinnedPaths })
      return pinnedPaths
    })
  }

  async reloadThemes(clearErrors = true) {
    if (clearErrors) this.errors = []
    const previousThemes = this.themes
    const previous = this.themes.find((theme) => theme.id === this.settings.themeId)
    const themes: Theme[] = [...builtinThemes, ...this.pluginThemes]
    for (const filename of (await readdir(this.themesDirectory)).sort()) {
      if (!filename.endsWith('.json')) continue
      try {
        const theme = parseTheme(JSON.parse(await readFile(path.join(this.themesDirectory, filename), 'utf8')))
        if (theme.background) throw new Error('背景图片必须随 App 插件分发')
        if (themes.some((entry) => entry.id === theme.id)) throw new Error(`主题 id 重复：${theme.id}`)
        themes.push(theme)
      } catch (error) {
        this.errors.push(`${filename}：${String(error)}`)
      }
    }
    if (!themes.some((theme) => theme.id === this.settings.themeId)) {
      if (previous && !previous.plugin) {
        themes.push(previous)
      } else {
        this.errors.push(`主题 ${this.settings.themeId} 不存在，已使用深色主题`)
        this.settings = { ...this.settings, themeId: 'dark' }
      }
    }
    if (this.settings.appearance) {
      for (const mode of ['light', 'dark'] as const) {
        const id = this.settings.appearance[`${mode}ThemeId`]
        if (!themes.some((entry) => entry.id === id)) {
          const cached = previousThemes.find((entry) => entry.id === id)
          if (cached && !cached.plugin) themes.push(cached)
          else this.settings.appearance[`${mode}ThemeId`] = mode
        }
      }
    }
    this.themes = themes
    return this.snapshot()
  }

  setPluginThemes(themes: Theme[]) {
    return this.enqueue(async () => {
      this.pluginThemes = structuredClone(themes)
      const pending = this.pendingPluginSelection
      this.pendingPluginSelection = undefined
      if (pending) {
        if (themes.some((theme) => theme.id === pending.themeId)) this.settings.themeId = pending.themeId
        for (const mode of ['light', 'dark'] as const) {
          const id = pending.appearance?.[`${mode}ThemeId`]
          if (id && this.settings.appearance && themes.some((theme) => theme.id === id))
            this.settings.appearance[`${mode}ThemeId`] = id
        }
      }
      const snapshot = await this.reloadThemes()
      await this.saveNow(snapshot.settings)
      return this.snapshot()
    })
  }

  snapshot(): SettingsSnapshot {
    return {
      settings: structuredClone(this.settings),
      themes: [...this.themes],
      themesDirectory: this.themesDirectory,
      errors: [...this.errors],
    }
  }
}
