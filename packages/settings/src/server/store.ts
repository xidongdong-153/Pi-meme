import { thinkingLevels } from '@pi-meme/contracts/pi'
import { mkdir, readFile, readdir, writeFile, rename, open, rm, lstat } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import path from 'node:path'
import { isAgentAccessMode } from '@pi-meme/contracts/agent-access'
import { projectAppIds } from '@pi-meme/contracts/desktop'
import type {
  AppearanceMigration,
  AppearanceMigrationResult,
  AppearanceOperation,
  AppearanceSaveResult,
  AppearanceSettings,
  DesktopSettings,
  SettingsSnapshot,
  SubagentDefaults,
  Theme,
} from '@pi-meme/contracts/settings'
import { defaultAppearance, migrateAppearance, validateAppearance } from '../shared/appearance'
import {
  applyAppearanceOperation,
  canonicalAppearance,
  changedAppearancePaths,
  validateAppearanceUpdate,
} from '../shared/appearance-update'
import { builtinThemes, parseTheme } from '../shared/themes'
import { defaultSidebarPreferences, parseSidebarPreferencesPatch, validateSidebarPreferences } from '../shared/sidebar'
import { DEFAULT_USER_PROFILE } from '../shared/user-profile'
import { storageLayoutRelativePaths } from '@pi-meme/contracts/storage-paths'

function normalizeEnabledSubagents(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 16 ||
    value.some((entry) => typeof entry !== 'string' || entry.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry))
  )
    throw new Error('子 Agent 启用列表无效')
  return [...new Set(value as string[])].sort()
}

function parseSubagentDefaults(value: unknown, partial = false): Partial<SubagentDefaults> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('子代理默认设置无效')
  const input = value as Record<string, unknown>
  if (Object.keys(input).some((key) => key !== 'model' && key !== 'thinkingLevel'))
    throw new Error('子代理默认设置包含未知字段')
  const result: Partial<SubagentDefaults> = {}
  if ('model' in input) {
    const model = input.model as Record<string, unknown> | null
    if (
      model !== null &&
      (!model ||
        typeof model !== 'object' ||
        Array.isArray(model) ||
        Object.keys(model).some((key) => key !== 'provider' && key !== 'id') ||
        typeof model.provider !== 'string' ||
        !model.provider.trim() ||
        typeof model.id !== 'string' ||
        !model.id.trim())
    )
      throw new Error('子代理默认模型无效')
    result.model =
      model === null ? null : { provider: (model.provider as string).trim(), id: (model.id as string).trim() }
  } else if (!partial) result.model = null
  if ('thinkingLevel' in input) {
    if (input.thinkingLevel !== null && !thinkingLevels.includes(input.thinkingLevel as never))
      throw new Error('子代理默认思考强度无效')
    result.thinkingLevel = input.thinkingLevel as SubagentDefaults['thinkingLevel']
  } else if (!partial) result.thinkingLevel = null
  return result
}

export class SettingsStore {
  settings: DesktopSettings = {
    themeId: 'dark',
    codemodeEnabled: true,
    mcpEnabled: true,
    subagentsEnabled: true,
    enabledSubagents: [],
    showComposerHint: true,
    showContextUsage: true,
    contextWindowArchive: false,
    appearance: defaultAppearance(),
    sidebar: defaultSidebarPreferences(),
  }
  private writes: Promise<unknown> = Promise.resolve()
  private themes = [...builtinThemes]
  private errors: string[] = []
  private configError = ''
  private loaded = false
  private fileFingerprint: string | null | undefined
  private migrationApplied = false
  private appearanceObserver?: (revision: string) => void
  private composerHintObserver?: (enabled: boolean) => Promise<void>
  private readonly writeContext = new AsyncLocalStorage<{
    clientId: string
    requestId: string
    source?: 'ui' | 'agent'
    hostId?: string
  }>()
  readonly themesDirectory: string
  readonly profileDirectory: string
  private pluginThemes: Theme[] = []
  private readonly settingsFile: string
  constructor(dataRoot: string) {
    this.themesDirectory = path.join(dataRoot, storageLayoutRelativePaths.themesDirectory)
    this.profileDirectory = path.join(dataRoot, storageLayoutRelativePaths.profileDirectory)
    this.settingsFile = path.join(dataRoot, storageLayoutRelativePaths.appConfigFile)
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

  setAppearanceObserver(listener: (revision: string) => void) {
    this.appearanceObserver = listener
  }

  setComposerHintObserver(listener: (enabled: boolean) => Promise<void>) {
    this.composerHintObserver = listener
  }

  withWriteContext<T>(
    context: { clientId: string; requestId: string; source?: 'ui' | 'agent'; hostId?: string },
    work: () => Promise<T>,
  ): Promise<T> {
    return this.writeContext.run(context, work)
  }

  load() {
    return this.enqueue(() => this.loadNow())
  }

  private fingerprint(value: string | Uint8Array) {
    return createHash('sha256').update(value).digest('hex')
  }

  private async assertFileTarget() {
    for (const target of [path.dirname(this.settingsFile), this.settingsFile]) {
      const info = await lstat(target).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code === 'ENOENT') return undefined
        throw cause
      })
      if (info?.isSymbolicLink()) throw new Error('应用配置文件和目录不能是符号链接')
    }
  }

  private async loadNow() {
    const hintEnabled = this.settings.showComposerHint !== false
    await mkdir(this.themesDirectory, { recursive: true })
    try {
      await this.assertFileTarget()
      const bytes = await readFile(this.settingsFile)
      const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      const value: unknown = JSON.parse(raw)
      this.validateSettings(value)
      const stored = { ...value } as DesktopSettings & { userExtensionPaths?: unknown }
      delete stored.userExtensionPaths
      this.settings = {
        ...stored,
        appearanceStorage: stored.appearanceStorage ?? { version: 1, legacyImport: 'complete' },
        codemodeEnabled: Boolean(value.codemodeEnabled || value.mcpEnabled),
        mcpEnabled: Boolean(value.mcpEnabled),
        subagentsEnabled: Boolean(value.subagentsEnabled),
        enabledSubagents: normalizeEnabledSubagents(value.enabledSubagents ?? []),
        showComposerHint: value.showComposerHint ?? true,
        showContextUsage: value.showContextUsage ?? true,
        contextWindowArchive: value.contextWindowArchive ?? false,
        sidebar: value.sidebar ?? defaultSidebarPreferences(),
      }
      this.fileFingerprint = this.fingerprint(bytes)
      this.configError = ''
    } catch (cause) {
      if (
        (cause as NodeJS.ErrnoException).code === 'ENOENT' &&
        this.fileFingerprint !== undefined &&
        this.fileFingerprint !== null
      )
        this.configError = '应用配置文件已消失；请恢复文件后重新读取，不会使用默认值覆盖'
      else if ((cause as NodeJS.ErrnoException).code === 'ENOENT' && (!this.loaded || this.fileFingerprint === null)) {
        this.fileFingerprint = null
        this.configError = ''
        this.settings.appearanceStorage = { version: 1, legacyImport: 'eligible' }
      } else this.configError = `无法读取桌面设置：${String(cause)}；原文件已保护，请修复后重新读取`
    }
    this.loaded = true
    this.settings.appearance = migrateAppearance(this.settings, this.themes)
    await this.reloadThemes()
    if (hintEnabled !== (this.settings.showComposerHint !== false))
      await this.composerHintObserver?.(this.settings.showComposerHint !== false)
    return this.snapshot()
  }

  private async assertWritable() {
    if (!this.loaded || this.configError) throw new Error(this.configError || '应用设置尚未读取，不能保存')
    try {
      await this.assertFileTarget()
      const raw = await readFile(this.settingsFile).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code === 'ENOENT') return null
        throw cause
      })
      if ((raw === null ? null : this.fingerprint(raw)) !== this.fileFingerprint)
        throw new Error('应用配置已被外部修改，请重新读取后保存；当前修改仍保留')
    } catch (cause) {
      this.configError = String(cause)
      throw cause
    }
  }

  private validateSettings(value: unknown): asserts value is DesktopSettings {
    const settings = value as DesktopSettings | null
    if (
      !settings ||
      typeof settings.themeId !== 'string' ||
      (settings.pinnedPaths !== undefined &&
        (!Array.isArray(settings.pinnedPaths) || settings.pinnedPaths.some((entry) => typeof entry !== 'string'))) ||
      (settings.preferredProjectApp !== undefined && !projectAppIds.includes(settings.preferredProjectApp))
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
    for (const key of ['showComposerHint', 'showContextUsage'] as const) {
      if (settings[key] !== undefined && typeof settings[key] !== 'boolean')
        throw new Error('编辑器显示开关必须是布尔值')
    }
    if (settings.contextWindowArchive !== undefined && typeof settings.contextWindowArchive !== 'boolean')
      throw new Error('上下文正文归档开关必须是布尔值')
    if (settings.subagentDefaults !== undefined) parseSubagentDefaults(settings.subagentDefaults)
    if (settings.enabledSubagents !== undefined) normalizeEnabledSubagents(settings.enabledSubagents)
    if (settings.appearance !== undefined) validateAppearance(settings.appearance)
    if (
      settings.appearanceStorage !== undefined &&
      (!settings.appearanceStorage ||
        typeof settings.appearanceStorage !== 'object' ||
        Array.isArray(settings.appearanceStorage) ||
        settings.appearanceStorage.version !== 1 ||
        !['eligible', 'complete'].includes(settings.appearanceStorage.legacyImport) ||
        Object.keys(settings.appearanceStorage).some((key) => key !== 'version' && key !== 'legacyImport'))
    )
      throw new Error('外观存储版本标记无效')
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
    return this.enqueue(() => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('应用设置必须是对象')
      const input = value as Partial<DesktopSettings>
      if (
        (input.themeId !== undefined && input.themeId !== this.settings.themeId) ||
        (input.appearance !== undefined &&
          (validateAppearance(input.appearance),
          canonicalAppearance(input.appearance) !== canonicalAppearance(this.settings.appearance!))) ||
        (input.appearanceStorage !== undefined &&
          JSON.stringify(input.appearanceStorage) !== JSON.stringify(this.settings.appearanceStorage))
      )
        throw new Error('外观修改必须携带修订并通过外观接口保存，请重新读取或更新客户端')
      return this.saveNow({ ...this.settings, ...input })
    })
  }

  saveSubagentDefaults(value: unknown) {
    return this.enqueue(async () => {
      const patch = parseSubagentDefaults(value, true)
      const defaults: SubagentDefaults = {
        model: null,
        thinkingLevel: null,
        ...this.settings.subagentDefaults,
        ...patch,
      }
      await this.saveNow({ ...this.settings, subagentDefaults: defaults }, false, false, true)
      return structuredClone(defaults)
    })
  }

  saveEditorSettings(value: unknown) {
    return this.enqueue(() => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('编辑器显示设置无效')
      for (const [key, entry] of Object.entries(value)) {
        if (key !== 'showComposerHint' && key !== 'showContextUsage' && key !== 'contextWindowArchive')
          throw new Error('编辑器显示设置包含未知字段')
        if (typeof entry !== 'boolean')
          throw new Error(
            key === 'contextWindowArchive' ? '上下文正文归档开关必须是布尔值' : '编辑器显示开关必须是布尔值',
          )
      }
      return this.saveNow({ ...this.settings, ...value })
    })
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

  private auditAppearance(
    operation: string,
    outcome: 'committed' | 'conflict' | 'rejected',
    before: AppearanceSettings,
    after = before,
  ) {
    try {
      console.info(
        JSON.stringify({
          event: 'appearance-write',
          time: new Date().toISOString(),
          source: this.writeContext.getStore() ? 'client-rpc' : 'host-internal',
          ...this.writeContext.getStore(),
          operation,
          outcome,
          beforeRevision: this.fingerprint(canonicalAppearance(before)),
          afterRevision: this.fingerprint(canonicalAppearance(after)),
          changedPaths: changedAppearancePaths(before, after),
        }),
      )
    } catch (cause) {
      console.error(`外观写入诊断不可用：${String(cause)}`)
    }
  }

  private async commitAppearance(appearance: AppearanceSettings, operation: string) {
    const before = this.settings.appearance!
    const changed = canonicalAppearance(before) !== canonicalAppearance(appearance)
    if (changed || this.settings.appearanceStorage?.legacyImport !== 'complete') {
      const themeId = appearance.mode === 'light' ? appearance.lightThemeId : appearance.darkThemeId
      await this.saveNow(
        {
          ...this.settings,
          appearance,
          themeId,
          appearanceStorage: { version: 1, legacyImport: 'complete' },
        },
        true,
      )
    }
    const snapshot = this.snapshot()
    this.auditAppearance(operation, 'committed', before, appearance)
    if (changed) {
      try {
        this.appearanceObserver?.(snapshot.appearanceRevision)
      } catch (cause) {
        console.error(`外观已保存，事件发送失败：${String(cause)}`)
      }
    }
    return snapshot
  }

  saveAppearance(value: unknown): Promise<AppearanceSaveResult> {
    return this.enqueue(async () => {
      const before = this.settings.appearance ?? defaultAppearance()
      try {
        validateAppearanceUpdate(value)
        await this.assertWritable()
        if (value.expectedRevision !== this.snapshot().appearanceRevision) {
          this.auditAppearance(value.operation.type, 'conflict', before)
          return { status: 'conflict', snapshot: this.snapshot() }
        }
        const next = applyAppearanceOperation(before, value.operation, this.themes)
        return { status: 'saved', snapshot: await this.commitAppearance(next, value.operation.type) }
      } catch (cause) {
        this.auditAppearance('update', 'rejected', before)
        throw cause
      }
    })
  }

  importLegacyAppearance(value: unknown): Promise<AppearanceMigrationResult> {
    return this.enqueue(async () => {
      await this.assertWritable()
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('旧外观迁移参数无效')
      const input = value as AppearanceMigration
      if (Object.keys(input).some((key) => key !== 'appearance' && key !== 'expectedRevision'))
        throw new Error('旧外观迁移包含未知字段')
      if (typeof input.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedRevision))
        throw new Error('旧外观迁移必须携带有效修订')
      if (this.settings.appearanceStorage?.legacyImport !== 'eligible')
        return { status: this.migrationApplied ? 'already-migrated' : 'host-authoritative', snapshot: this.snapshot() }
      if (input.expectedRevision !== this.snapshot().appearanceRevision)
        return { status: 'conflict', snapshot: this.snapshot() }
      validateAppearance(input.appearance)
      const snapshot = await this.commitAppearance(structuredClone(input.appearance), 'legacy-migration')
      this.migrationApplied = true
      return { status: 'applied', snapshot }
    })
  }

  selectTheme(id: string, expectedRevision: unknown): Promise<AppearanceSaveResult> {
    const operation: AppearanceOperation = { type: 'select-theme', themeId: id }
    return this.saveAppearance({ expectedRevision, operation })
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

  private async saveNow(value: unknown, appearanceOnly = false, sidebarOnly = false, subagentsOnly = false) {
    const hintEnabled = this.settings.showComposerHint !== false
    await this.assertWritable()
    this.validateSettings(value)
    const appearance = appearanceOnly ? value.appearance : this.settings.appearance
    const next: DesktopSettings = {
      subagentDefaults: subagentsOnly ? value.subagentDefaults : this.settings.subagentDefaults,
      defaultAgentPlugins: [...new Set(value.defaultAgentPlugins ?? this.settings.defaultAgentPlugins ?? [])],
      sidebar: sidebarOnly ? value.sidebar : (this.settings.sidebar ?? defaultSidebarPreferences()),
      appearance,
      appearanceStorage: appearanceOnly ? value.appearanceStorage : this.settings.appearanceStorage,
      themeId: appearanceOnly ? value.themeId : this.settings.themeId,
      mcpEnabled: value.mcpEnabled ?? this.settings.mcpEnabled ?? false,
      subagentsEnabled: value.subagentsEnabled ?? this.settings.subagentsEnabled ?? false,
      enabledSubagents: normalizeEnabledSubagents(value.enabledSubagents ?? this.settings.enabledSubagents ?? []),
      codemodeEnabled: Boolean(
        (value.mcpEnabled ?? this.settings.mcpEnabled) || (value.codemodeEnabled ?? this.settings.codemodeEnabled),
      ),
      defaultAccessMode: value.defaultAccessMode ?? this.settings.defaultAccessMode,
      showComposerHint: value.showComposerHint ?? this.settings.showComposerHint ?? true,
      showContextUsage: value.showContextUsage ?? this.settings.showContextUsage ?? true,
      contextWindowArchive: value.contextWindowArchive ?? this.settings.contextWindowArchive ?? false,
      pinnedPaths: Array.isArray(value.pinnedPaths)
        ? value.pinnedPaths.filter((entry): entry is string => typeof entry === 'string')
        : (this.settings.pinnedPaths ?? []),
      preferredProjectApp: value.preferredProjectApp ?? this.settings.preferredProjectApp ?? 'finder',
    }
    await mkdir(path.dirname(this.settingsFile), { recursive: true, mode: 0o700 })
    const temporary = path.join(path.dirname(this.settingsFile), `.app-${randomUUID()}.tmp`)
    const raw = `${JSON.stringify(next, null, 2)}\n`
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(raw, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await this.assertWritable()
      await rename(temporary, this.settingsFile)
      this.fileFingerprint = this.fingerprint(raw)
      this.settings = next
    } finally {
      await rm(temporary, { force: true }).catch((cause: unknown) =>
        console.error(`无法清理设置临时文件：${String(cause)}`),
      )
    }
    if (hintEnabled !== (this.settings.showComposerHint !== false))
      await this.composerHintObserver?.(this.settings.showComposerHint !== false)
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

  private readonly pinAliases = new Map<string, Set<string>>()

  registerPinAliases(paths: string[]) {
    const group = new Set(paths.filter(Boolean))
    for (const target of group) this.pinAliases.set(target, group)
  }

  setPinned(targetPath: string, pinned: boolean, aliases: string[] = [], mirrors: string[] = []): Promise<string[]> {
    if (typeof targetPath !== 'string' || !targetPath || typeof pinned !== 'boolean')
      return Promise.reject(new Error('置顶参数无效'))
    this.registerPinAliases([targetPath, ...aliases, ...mirrors])
    return this.enqueue(async () => {
      const current = new Set(this.settings.pinnedPaths ?? [])
      for (const alias of aliases) current.delete(alias)
      for (const target of [targetPath, ...mirrors]) {
        if (pinned) current.add(target)
        else current.delete(target)
      }
      const pinnedPaths = [...current]
      await this.saveNow({ ...this.settings, pinnedPaths })
      return pinnedPaths
    })
  }

  togglePin(targetPath: string): Promise<string[]> {
    return this.enqueue(async () => {
      const current = new Set(this.settings.pinnedPaths ?? [])
      const group = this.pinAliases.get(targetPath) ?? new Set([targetPath])
      const pinned = [...group].some((target) => current.has(target))
      for (const target of group) {
        if (pinned) current.delete(target)
        else current.add(target)
      }
      const pinnedPaths = Array.from(current)
      await this.saveNow({ ...this.settings, pinnedPaths })
      return pinnedPaths
    })
  }

  async reloadThemes(clearErrors = true) {
    if (clearErrors) this.errors = []
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
    for (const mode of ['light', 'dark'] as const) {
      const id = this.settings.appearance?.[`${mode}ThemeId`]
      if (id && !themes.some((theme) => theme.id === id && theme.appearance === mode))
        this.errors.push(`主题 ${id} 暂不可用，正在使用内置主题；已保留原选择与字体`)
    }
    this.themes = themes
    return this.snapshot()
  }

  setPluginThemes(themes: Theme[]) {
    return this.enqueue(async () => {
      this.pluginThemes = structuredClone(themes)
      return this.reloadThemes()
    })
  }

  snapshot(): SettingsSnapshot {
    return {
      settings: structuredClone(this.settings),
      appearanceRevision: this.fingerprint(canonicalAppearance(this.settings.appearance ?? defaultAppearance())),
      writeState: this.configError
        ? { status: 'blocked', error: this.configError }
        : { status: this.loaded ? 'ready' : 'blocked', ...(!this.loaded ? { error: '应用设置尚未读取' } : {}) },
      legacyAppearanceImport: this.settings.appearanceStorage?.legacyImport ?? 'complete',
      themes: [...this.themes],
      themesDirectory: this.themesDirectory,
      errors: [...(this.configError ? [this.configError] : []), ...this.errors],
    }
  }
}
