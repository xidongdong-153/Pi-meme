import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { loadPiSdk } from '@pi-meme/pi-runtime/sdk/load'
import { desktopBuiltinProviderIds } from '@pi-meme/pi-runtime/sdk/model-runtime'
import { modelHeaderEntries, validateApi, type ModelConfigStore } from '@pi-meme/models/server/config-store'
import type { McpConfigStore } from '@pi-meme/mcp/server/config-store'
import type { SettingsStore } from '@pi-meme/settings/server/store'
import type { InstructionsStore } from '@pi-meme/settings/server/instructions'
import type { ResourceStore } from '@pi-meme/resources/server/resource-store'
import { readResourceFiles, resourceRevision, type ResourceFile } from '@pi-meme/resources/server/resource-files'
import {
  formatKeybindingDisplay,
  keybindingsConflict,
  resolveKeybinding,
  SHORTCUT_DEFINITIONS,
  type ShortcutPlatform,
  type ShortcutPreferences,
} from '@pi-meme/contracts/keyboard-shortcuts'
import type {
  PiMigrationApply,
  PiMigrationCategory,
  PiMigrationItem,
  PiMigrationResult,
  PiMigrationScan,
} from '@pi-meme/contracts/pi-migration'
import { storageLayoutRelativePaths as storage } from '@pi-meme/contracts/storage-paths'
import { contains, physicalPath } from './storage/files'
import {
  compareValue,
  displayText,
  listDirectory,
  parsePiPrompt,
  readConfigFile,
  readObject,
  record,
  replaceConfigFile,
  type JsonRecord,
} from './pi-migration-files'
import {
  convertPiTheme,
  literalSecret,
  mergePiMcp,
  migrationId,
  piMcpLocation,
  piModelHeaders,
  piRuntimePreferences,
  piShortcut,
  splitPiMcp,
  splitPiProvider,
} from './pi-migration-format'

export type PiMigrationShortcuts = {
  platform: ShortcutPlatform
  read: () => Promise<ShortcutPreferences>
  save: (value: ShortcutPreferences, expected: ShortcutPreferences) => Promise<ShortcutPreferences>
}

type Services = {
  root: string
  instructions: InstructionsStore
  resources: ResourceStore
  models: ModelConfigStore
  mcp: McpConfigStore
  settings: SettingsStore
  shortcuts: PiMigrationShortcuts
  sealBackup?: (value: unknown) => string
}

type EntryInfo = Omit<PiMigrationItem, 'status' | 'before' | 'after'>
type Backup = { label: string; value: unknown; sensitive?: boolean }
type Target = { value?: unknown; before?: string; backup?: Backup; guard?: unknown }
type PlanEntry = {
  item: PiMigrationItem
  fingerprint?: unknown
  execute?: (backup: (value: Backup) => Promise<void>) => Promise<void>
}

const same = (left: unknown, right: unknown) => compareValue(left) === compareValue(right)
const itemOrder: PiMigrationCategory[] = [
  'instruction',
  'skill',
  'prompt',
  'mcp',
  'model',
  'setting',
  'theme',
  'shortcut',
  'credential',
]

function reason(cause: unknown) {
  const code = (cause as NodeJS.ErrnoException | undefined)?.code
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return '无法访问配置路径，请检查读取或写入权限'
  if (code === 'ENOSPC') return '磁盘空间不足'
  const message = cause instanceof Error ? cause.message : '无法处理此配置项'
  return message.slice(0, 240)
}

function filePreview(content: string | undefined) {
  return content === undefined ? undefined : displayText(content)
}

function skillPreview(files: ResourceFile[], entry: string) {
  const body = filePreview(files.find((file) => file.path === entry)?.content.toString('utf8')) ?? ''
  const paths = files.filter((file) => file.path !== entry).map((file) => file.path)
  return paths.length ? `${body}\n\n附属文件（${paths.length}）\n${displayText(paths.join('\n'))}` : body
}

function configPreview(config: JsonRecord) {
  return displayText(
    JSON.stringify(
      config,
      (key, value: unknown) => {
        if (
          /^(?:api[_-]?key|access[_-]?token|auth[_-]?token|authorization|client[_-]?secret|password|secret|token)$/i.test(
            key,
          )
        )
          return '••••'
        if (/^(?:baseUrl|url|callbackUrl)$/.test(key) && typeof value === 'string') {
          const url = URL.parse(value)
          return url && url.origin !== 'null' ? url.origin : '••••'
        }
        return value
      },
      2,
    ),
  )
}

class MigrationPlan {
  readonly entries = new Map<string, PlanEntry>()

  block(info: EntryInfo, message: string) {
    this.assertSpace(info.id)
    this.entries.set(info.id, { item: { ...info, status: 'blocked', note: message } })
  }

  private assertSpace(id: string) {
    if (!this.entries.has(id) && this.entries.size >= 500)
      throw new Error('检测到的配置项超过 500 项，请缩小 Pi 用户配置目录后重新扫描')
  }

  async add<T extends Target>(
    info: EntryInfo,
    incoming: unknown,
    after: string | undefined,
    read: () => Promise<T>,
    write: (current: T) => Promise<void>,
  ) {
    if (this.entries.has(info.id)) {
      this.block(info, '来源中有多个同名配置，请保留一个后重新扫描')
      return
    }
    this.assertSpace(info.id)
    try {
      const { value, guard, before } = await read()
      const status = value === undefined ? 'new' : same(value, incoming) ? 'same' : 'conflict'
      const fingerprint = [incoming, value, guard]
      const item = { ...info, status, before, after } as const
      const execute = async (backup: (value: Backup) => Promise<void>) => {
        const current = await read()
        if (!same(current.value, value) || !same(current.guard, guard)) throw new Error('目标配置已变化，请重新扫描')
        if (current.backup) await backup(current.backup)
        try {
          await write(current)
        } catch (cause) {
          const latest = await read().catch(() => undefined)
          if (latest && same(latest.value, current.value) && same(latest.guard, current.guard))
            throw new Error(`${reason(cause)}。${current.value === undefined ? '未写入此项' : '现有配置已保留'}`)
          throw cause
        }
      }
      this.entries.set(info.id, { item, fingerprint, execute })
    } catch (cause) {
      this.block(info, reason(cause))
    }
  }

  list() {
    return [...this.entries.values()].sort(
      (a, b) => itemOrder.indexOf(a.item.category) - itemOrder.indexOf(b.item.category),
    )
  }
}

function parseApply(value: unknown): PiMigrationApply {
  const input = record(value)
  const ids = (items: unknown): items is string[] =>
    Array.isArray(items) &&
    items.length <= 500 &&
    items.every((item) => typeof item === 'string' && item.length <= 2056)
  if (
    !input ||
    typeof input.revision !== 'string' ||
    !/^[\da-f]{64}$/.test(input.revision) ||
    !ids(input.itemIds) ||
    !ids(input.credentialIds) ||
    Object.keys(input).some((key) => !['revision', 'itemIds', 'credentialIds'].includes(key))
  )
    throw new Error('迁移确认参数无效')
  return { revision: input.revision, itemIds: input.itemIds, credentialIds: input.credentialIds }
}

export class PiMigration {
  private readonly revisionKey = randomBytes(32)
  private applying = false

  constructor(private readonly services: Services) {}

  async scan(): Promise<PiMigrationScan> {
    const { source, revision, entries } = await this.plan()
    return { source, revision, items: entries.map(({ item }) => item) }
  }

  async apply(value: unknown): Promise<PiMigrationResult> {
    const input = parseApply(value)
    if (this.applying) throw new Error('正在导入 Pi 配置，请等待完成')
    this.applying = true
    try {
      const { revision, entries } = await this.plan()
      if (revision !== input.revision) throw new Error('来源或目标配置在预览后已变化，请重新扫描')
      const selected = new Set([...input.itemIds, ...input.credentialIds])
      const byId = new Map(entries.map(({ item }) => [item.id, item]))
      if (!selected.size || selected.size !== input.itemIds.length + input.credentialIds.length)
        throw new Error('请选择要导入的配置')
      for (const id of selected) {
        const item = byId.get(id)
        if (
          !item ||
          item.status === 'blocked' ||
          item.status === 'same' ||
          (item.category === 'credential') !== input.credentialIds.includes(id)
        )
          throw new Error('导入选择包含不可迁移的项目，请重新扫描')
        if (item.requires && byId.get(item.requires)?.status !== 'same' && !selected.has(item.requires))
          throw new Error('请先选择对应的服务配置，再确认导入凭据')
      }
      const result: PiMigrationResult = { items: [] }
      const imported = new Set<string>()
      const backupFolder = path.join(storage.backupsDirectory, 'pi-migration', `${Date.now()}-${randomUUID()}`)
      for (const { item, execute } of entries) {
        const { id, name, category } = item
        const identity = { id, name, category }
        if (!selected.has(id) || !execute) {
          const message =
            item.status === 'same'
              ? (item.note ?? '内容相同')
              : item.status === 'blocked'
                ? (item.note ?? '无法导入')
                : item.status === 'conflict'
                  ? '保留现有配置'
                  : category === 'credential'
                    ? '未选择导入凭据'
                    : '未选择导入'
          result.items.push({ ...identity, status: 'skipped', message })
          continue
        }
        if (item.requires && byId.get(item.requires)?.status !== 'same' && !imported.has(item.requires)) {
          result.items.push({ ...identity, status: 'skipped', message: '对应的服务配置未导入' })
          continue
        }
        try {
          await execute(async ({ label, value, sensitive }) => {
            const { sealBackup } = this.services
            if (sensitive && !sealBackup) throw new Error('无法创建加密备份，已保留现有配置')
            const backup = sensitive ? { label, encrypted: sealBackup!(value) } : { label, value }
            const relative = path.join(backupFolder, `${result.items.length + 1}.json`)
            await replaceConfigFile(this.services.root, relative, undefined, `${JSON.stringify(backup, null, 2)}\n`)
            result.backupDirectory = path.join(this.services.root, backupFolder)
          })
          imported.add(id)
          result.items.push({
            ...identity,
            status: 'imported',
            message: item.status === 'conflict' ? '已覆盖' : '已导入',
          })
        } catch (cause) {
          result.items.push({ ...identity, status: 'failed', message: reason(cause) })
        }
      }
      return result
    } finally {
      this.applying = false
    }
  }

  private async plan() {
    const sdk = await loadPiSdk()
    const source = path.resolve(sdk.getAgentDir())
    const plan = new MigrationPlan()
    let root: string | undefined
    try {
      root = await realpath(source)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`无法读取本机 Pi 目录：${reason(cause)}`)
    }
    if (root) {
      const destination = await realpath(this.services.root)
      if (contains(root, destination) || contains(destination, root))
        throw new Error('Pi CLI 与 Pi meme 数据目录必须相互独立')
      await this.instructions(plan, root)
      await this.skills(plan, root, sdk.parseFrontmatter)
      await this.prompts(plan, root, sdk.parseFrontmatter)
      await this.mcp(plan, root)
      await this.models(plan, root)
      await this.preferences(plan, root)
      await this.themes(plan, root)
      await this.shortcuts(plan, root)
    }
    const entries = plan.list()
    const revision = createHmac('sha256', this.revisionKey)
      .update(compareValue([source, root, entries.map(({ item, fingerprint }) => [item, fingerprint])]))
      .digest('hex')
    return { source, revision, entries }
  }

  private async sourceObject(plan: MigrationPlan, root: string, filename: string, category: PiMigrationCategory) {
    try {
      const value = await readConfigFile(root, filename)
      return value === undefined ? undefined : readObject(value, filename)
    } catch (cause) {
      plan.block({ id: `${category}:${filename}`, category, name: filename, source: filename }, reason(cause))
      return undefined
    }
  }

  private async sourceDirectory(plan: MigrationPlan, root: string, directory: string, category: PiMigrationCategory) {
    try {
      return await listDirectory(root, directory)
    } catch (cause) {
      plan.block({ id: `${category}:${directory}`, category, name: directory, source: directory }, reason(cause))
      return []
    }
  }

  private async instructions(plan: MigrationPlan, sourceRoot: string) {
    const { instructions } = this.services
    for (const [kind, names] of [
      ['agents', ['AGENTS.override.md', 'AGENTS.md']],
      ['system', ['SYSTEM.md']],
      ['append-system', ['APPEND_SYSTEM.md']],
    ] as const) {
      for (const filename of names) {
        const info = { id: `instruction:${kind}`, category: 'instruction', name: filename, source: filename } as const
        try {
          const value = await readConfigFile(sourceRoot, filename)
          if (value === undefined) continue
          await plan.add(
            info,
            value,
            filePreview(value),
            async () => {
              const file = await instructions.hostFile(kind)
              return {
                file,
                value: file.exists ? file.content : undefined,
                guard: file.revision,
                before: file.exists ? filePreview(file.content) : undefined,
                backup: file.exists ? { label: file.path, value: file.content } : undefined,
              }
            },
            ({ file }) => instructions.save({ kind, content: value, revision: file.revision }),
          )
        } catch (cause) {
          plan.block(info, reason(cause))
        }
        break
      }
    }
  }

  private async skills(
    plan: MigrationPlan,
    sourceRoot: string,
    parseFrontmatter: Awaited<ReturnType<typeof loadPiSdk>>['parseFrontmatter'],
  ) {
    const { resources } = this.services
    const top = await this.sourceDirectory(plan, sourceRoot, 'skills', 'skill')
    let visited = 0
    let capturedBytes = 0
    const visit = async (relative: string, depth: number, entries: typeof top): Promise<void> => {
      visited += entries.length
      if (depth > 20 || visited > 2_000) throw new Error('Pi 技能目录的层级或文件数超限')
      const entry = entries.find(({ name }) => name === 'SKILL.md')
      const candidates = entry
        ? [entry]
        : depth === 0
          ? entries.filter((file) => file.name.endsWith('.md') && !file.name.startsWith('.'))
          : []
      for (const file of candidates) {
        const filename = `${relative}/${file.name}`
        let info: EntryInfo = { id: `skill:${filename}`, category: 'skill', name: file.name, source: filename }
        try {
          const value = await readConfigFile(sourceRoot, filename)
          if (value === undefined) continue
          const { frontmatter } = parseFrontmatter(value)
          if (typeof frontmatter.description !== 'string' || !frontmatter.description.trim()) {
            if (entry) throw new Error('技能缺少 description')
            continue
          }
          const name =
            typeof frontmatter.name === 'string' && frontmatter.name ? frontmatter.name : path.basename(relative)
          if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64)
            throw new Error('技能名称无法在 Pi meme 中使用')
          info = { ...info, id: `skill:${name}`, name }
          const source = await physicalPath(sourceRoot, entry ? relative : filename)
          if (!source) throw new Error('技能来源已移动')
          const files = await readResourceFiles(source)
          capturedBytes += files.reduce((size, item) => size + item.content.length, 0)
          if (capturedBytes > 64 * 1024 * 1024) throw new Error('本次扫描的技能文件总大小超过 64 MiB')
          const document = files.find((part) => part.path === file.name)
          if (!document?.content.equals(Buffer.from(value))) throw new Error('技能源文件在读取期间变化，请重新扫描')
          if (!frontmatter.name) {
            const normalized = value.replace(/^(\uFEFF?---\r?\n)/, `$1name: ${name}\n`)
            if (normalized === value) throw new Error('技能缺少可识别的名称')
            document.content = Buffer.from(normalized)
          }
          const revision = resourceRevision(files)
          await plan.add(
            info,
            revision,
            skillPreview(files, file.name),
            async () => {
              const existing = (await resources.peekCatalog()).items.find(
                (item) => item.kind === 'skill' && item.name === name && item.scope === 'host',
              )
              if (!existing) return { value: undefined }
              if (existing.owner.type !== 'loose') throw new Error('此名称由系统或插件提供')
              const current = await resources.readSkillFiles(existing.id, existing.revision)
              const currentEntry = current.find((item) => item.path === 'SKILL.md')?.path ?? current[0].path
              return {
                existing,
                value: existing.revision,
                before: skillPreview(current, currentEntry),
                backup: {
                  label: `技能/${name}`,
                  value: current.map((item) => ({
                    path: item.path,
                    mode: item.mode,
                    base64: item.content.toString('base64'),
                  })),
                },
              }
            },
            ({ existing }) =>
              resources
                .import({ replace: existing && { id: existing.id, revision: existing.revision } }, undefined, {
                  files,
                  sourcePath: source,
                })
                .then(() => {}),
          )
        } catch (cause) {
          plan.block(info, reason(cause))
        }
      }
      if (entry) return
      for (const directory of entries) {
        if (directory.name.startsWith('.') || directory.name === 'node_modules') continue
        const child = `${relative}/${directory.name}`
        if (directory.isSymbolicLink() && !directory.name.endsWith('.md')) {
          plan.block(
            { id: `skill:${child}`, category: 'skill', name: directory.name, source: child },
            '技能目录链接无法安全导入',
          )
        } else if (directory.isDirectory())
          await visit(child, depth + 1, await this.sourceDirectory(plan, sourceRoot, child, 'skill'))
      }
    }
    await visit('skills', 0, top)
  }

  private async prompts(
    plan: MigrationPlan,
    sourceRoot: string,
    parseFrontmatter: Awaited<ReturnType<typeof loadPiSdk>>['parseFrontmatter'],
  ) {
    for (const { name } of await this.sourceDirectory(plan, sourceRoot, 'prompts', 'prompt')) {
      if (!name.endsWith('.md')) continue
      const filename = `prompts/${name}`
      const info = {
        id: `prompt:${name}`,
        category: 'prompt',
        name: `/${name.slice(0, -3)}`,
        source: filename,
      } as const
      try {
        const value = await readConfigFile(sourceRoot, filename)
        if (value === undefined) continue
        parsePiPrompt(filename, value, parseFrontmatter)
        await this.textFile(plan, info, value, path.join(storage.agentPromptsDirectory, name))
      } catch (cause) {
        plan.block(info, reason(cause))
      }
    }
  }

  private async textFile(plan: MigrationPlan, info: EntryInfo, value: string, target: string) {
    const { root } = this.services
    await plan.add(
      info,
      value,
      filePreview(value),
      async () => {
        const existing = await readConfigFile(root, target)
        return {
          value: existing,
          before: filePreview(existing),
          backup: existing === undefined ? undefined : { label: target, value: existing },
        }
      },
      ({ value: current }) => replaceConfigFile(root, target, current, value),
    )
  }

  private async mcp(plan: MigrationPlan, sourceRoot: string) {
    const source = await this.sourceObject(plan, sourceRoot, 'mcp.json', 'mcp')
    if (!source) return
    const servers = record(source.mcpServers)
    if (!servers && source.mcpServers !== undefined) {
      plan.block(
        { id: 'mcp:file', category: 'mcp', name: 'mcp.json', source: 'mcp.json' },
        'mcpServers 必须是服务键值对象',
      )
      return
    }
    const { mcp } = this.services
    for (const [name, raw] of Object.entries(servers ?? {})) {
      const id = `mcp:${name}`
      const info = { id, category: 'mcp', name, source: 'mcp.json', note: '导入后需在 MCP 设置中授权' } as const
      try {
        const parsed = record(raw)
        if (!parsed || !migrationId(name) || !/^[\w-]+$/.test(name)) throw new Error('MCP 服务名称或配置无效')
        const { config, credentials } = splitPiMcp(parsed)
        if (typeof config.url !== 'string' && typeof config.command !== 'string')
          throw new Error('MCP 服务缺少 URL 或命令')
        const hasCredentials = Object.keys(credentials).length > 0
        const read = async () => {
          const { revision, servers: target } = await mcp.readMigrationServers()
          const existing = target.get(name)
          if (existing && !existing.config) throw new Error('现有 MCP 连接配置不可读取')
          const old = existing?.config && splitPiMcp(existing.config)
          return { revision, old, existing }
        }
        await plan.add(
          { ...info, note: hasCredentials ? '连接参数与凭据可单独选择，导入后需授权' : info.note },
          config,
          configPreview(config),
          async () => {
            const current = await read()
            const { old, existing } = current
            return {
              ...current,
              value: old?.config,
              before: old && configPreview(old.config),
              guard: old?.credentials,
              backup: existing && { label: `MCP/${name}`, value: existing, sensitive: true },
            }
          },
          async ({ old, revision }) => {
            const keep = old?.credentials ?? {}
            if (Object.keys(keep).length && !same(piMcpLocation(old!.config), piMcpLocation(config)))
              throw new Error('目标地址或命令已有凭据，请先在 MCP 设置中处理原凭据')
            await mcp.importPiServer(name, mergePiMcp(config, keep), revision)
          },
        )
        if (!hasCredentials) continue
        const credentialInfo = {
          id: `credential:mcp:${name}`,
          category: 'credential',
          name: `${name} 连接参数与凭据`,
          source: 'mcp.json',
          requires: id,
        } as const
        const original = await read()
        if (Object.keys(original.old?.credentials ?? {}).length) {
          plan.block(credentialInfo, '已保存现有连接参数或凭据，导入会保留原值')
          continue
        }
        await plan.add(
          credentialInfo,
          credentials,
          undefined,
          async () => {
            const current = await read()
            const saved = current.old?.credentials
            return { ...current, value: saved && Object.keys(saved).length ? saved : undefined }
          },
          async ({ old, revision }) => {
            if (!old || !same(old.config, config)) throw new Error('对应的 MCP 配置已变化，请重新扫描')
            await mcp.importPiServer(name, mergePiMcp(old.config, credentials), revision)
          },
        )
      } catch (cause) {
        if (!plan.entries.has(id)) plan.block(info, reason(cause))
        else
          plan.block(
            {
              id: `credential:mcp:${name}`,
              category: 'credential',
              name: `${name} 连接参数与凭据`,
              source: 'mcp.json',
            },
            reason(cause),
          )
      }
    }
  }

  private async models(plan: MigrationPlan, sourceRoot: string) {
    const { models } = this.services
    const modelsFile = await this.sourceObject(plan, sourceRoot, 'models.json', 'model')
    const auth = await this.sourceObject(plan, sourceRoot, 'auth.json', 'credential')
    const definitions = record(modelsFile?.providers)
    if (modelsFile && !definitions)
      plan.block(
        { id: 'model:file', category: 'model', name: 'models.json', source: 'models.json' },
        'providers 必须是服务商键值对象',
      )
    if (!definitions && !auth) return
    const builtins = await desktopBuiltinProviderIds()
    for (const provider of new Set([...Object.keys(definitions ?? {}), ...Object.keys(auth ?? {})])) {
      if (!migrationId(provider)) {
        plan.block(
          { id: `model:${provider}`, category: 'model', name: provider, source: 'models.json / auth.json' },
          '服务商 ID 无效',
        )
        continue
      }
      const id = `model:${provider}`
      const definition = Object.hasOwn(definitions ?? {}, provider) ? definitions![provider] : undefined
      const configInfo = { id, category: 'model', name: provider, source: 'models.json' } as const
      let config: JsonRecord | undefined
      const read = async () => {
        const { providers, revision } = await models.readMigrationProviders()
        const raw = Object.hasOwn(providers, provider) ? providers[provider] : undefined
        const current = record(raw)
        if (raw !== undefined && !current) throw new Error('现有模型服务商格式无效')
        const credentials = models.credentialStorage.get(`model-provider:${provider}`)
        return { revision, raw: current, config: current && splitPiProvider(current), credentials }
      }
      if (definition !== undefined) {
        try {
          const parsed = record(definition)
          if (!parsed) throw new Error('服务商必须是 JSON 对象')
          config = splitPiProvider(parsed)
          if (config.api !== undefined) validateApi(config.api)
          if (
            !builtins.has(provider) &&
            (!config.baseUrl || !(config.models as unknown[] | undefined)?.length || !config.api)
          )
            throw new Error('自定义服务商需要 API 地址、协议和模型列表')
          const incoming = config
          await plan.add(
            configInfo,
            incoming,
            configPreview(incoming),
            async () => {
              const current = await read()
              return {
                ...current,
                value: current.config,
                before: current.config && configPreview(current.config),
                guard: [current.raw, current.credentials],
                backup: current.raw && {
                  label: `模型/${provider}`,
                  value: { config: current.raw, credentials: current.credentials },
                  sensitive: true,
                },
              }
            },
            async ({ revision }) => {
              await models.importPiProvider(provider, revision, incoming)
            },
          )
        } catch (cause) {
          plan.block(configInfo, reason(cause))
        }
      }
      const rawAuth = Object.hasOwn(auth ?? {}, provider) ? auth![provider] : undefined
      const saved = record(rawAuth)
      const key =
        literalSecret(saved?.type === 'api_key' ? saved.key : typeof rawAuth === 'string' ? rawAuth : undefined) ??
        literalSecret(record(definition)?.apiKey)
      const keyInfo = {
        id: `credential:api-key:${provider}`,
        category: 'credential',
        name: `${provider} API Key`,
        source: rawAuth === undefined ? 'models.json' : 'auth.json',
        requires: definition === undefined ? undefined : id,
      } as const
      const assertDestination = (target: Awaited<ReturnType<typeof read>>) => {
        if (definition !== undefined && (!config || !same(target.config, config)))
          throw new Error('对应的模型配置已变化，请重新扫描')
        if (
          definition === undefined &&
          (!builtins.has(provider) ||
            target.raw?.baseUrl !== undefined ||
            modelHeaderEntries(target.raw ?? {})
              .slice(1)
              .some(([, model]) => model.baseUrl !== undefined))
        )
          throw new Error('目标服务地址与凭据来源无法匹配')
      }
      if (saved?.type === 'oauth')
        plan.block(
          { ...keyInfo, id: `credential:oauth:${provider}`, name: `${provider} OAuth` },
          '请在模型设置中重新登录',
        )
      if (key) {
        try {
          const before = await read()
          if (record(before.credentials ? JSON.parse(before.credentials) : undefined)?.credential || before.raw?.apiKey)
            plan.block(keyInfo, '已保存凭据，导入会保留原值')
          else if (definition === undefined && (!builtins.has(provider) || before.raw?.baseUrl !== undefined))
            plan.block(keyInfo, '目标服务地址与凭据来源无法匹配')
          else
            await plan.add(
              keyInfo,
              key,
              undefined,
              async () => {
                const current = await read()
                return {
                  ...current,
                  value:
                    record(current.credentials ? JSON.parse(current.credentials) : undefined)?.credential ??
                    current.raw?.apiKey,
                }
              },
              async (current) => {
                assertDestination(current)
                if (!(await models.importPiApiKey(provider, current.revision, key)))
                  throw new Error('目标已有凭据，原值已保留')
              },
            )
        } catch (cause) {
          plan.block(keyInfo, reason(cause))
        }
      } else if (saved?.type !== 'oauth' && (rawAuth !== undefined || record(definition)?.apiKey !== undefined))
        plan.block(keyInfo, '只支持可直接保存的 API Key，环境变量和外部命令需重新配置')
      const withHeaders = record(definition)
      if (!withHeaders) continue
      const headersInfo = {
        ...keyInfo,
        id: `credential:model-headers:${provider}`,
        name: `${provider} 请求头`,
        source: 'models.json',
      }
      try {
        const { values, omitted } = piModelHeaders(withHeaders)
        const scopes = new Set(values.map(([scope]) => scope))
        const hasHeaders = (raw: JsonRecord | undefined) =>
          modelHeaderEntries(raw ?? {}).some(([scope, entry]) => scopes.has(scope) && entry.headers !== undefined)
        if (values.length) {
          if (hasHeaders((await read()).raw)) plan.block(headersInfo, '已保存请求头，导入会保留原值')
          else
            await plan.add(
              { ...headersInfo, note: omitted ? '环境变量或外部命令引用需要在模型设置中补齐' : undefined },
              values,
              undefined,
              async () => {
                const current = await read()
                return { ...current, value: hasHeaders(current.raw) ? '已有请求头' : undefined }
              },
              async (current) => {
                assertDestination(current)
                await models.importPiHeaders(provider, current.revision, values)
              },
            )
        } else if (omitted) plan.block(headersInfo, '环境变量或外部命令引用需要在模型设置中补齐')
      } catch (cause) {
        plan.block(headersInfo, reason(cause))
      }
    }
  }

  private async preferences(plan: MigrationPlan, sourceRoot: string) {
    const source = await this.sourceObject(plan, sourceRoot, 'settings.json', 'setting')
    if (!source) return
    const { root } = this.services
    const filename = storage.agentSettingsFile
    for (const { id, name, patch, error } of piRuntimePreferences(source)) {
      const info = { id: `setting:${id}`, category: 'setting', name, source: 'settings.json' } as const
      if (error) {
        plan.block(info, error)
        continue
      }
      await plan.add(
        info,
        patch,
        displayText(JSON.stringify(patch, null, 2)),
        async () => {
          const raw = await readConfigFile(root, filename)
          const data = raw === undefined ? {} : readObject(raw, 'Pi meme 设置')
          const selected = Object.fromEntries(
            Object.keys(patch)
              .filter((key) => Object.hasOwn(data, key))
              .map((key) => [key, data[key]]),
          )
          const value = Object.keys(selected).length ? selected : undefined
          return {
            raw,
            data,
            value,
            before: value && displayText(JSON.stringify(value, null, 2)),
            backup: value && { label: `${filename}/${id}`, value },
          }
        },
        ({ raw, data }) =>
          replaceConfigFile(root, filename, raw, `${JSON.stringify({ ...data, ...patch }, null, 2)}\n`),
      )
    }
  }

  private async themes(plan: MigrationPlan, sourceRoot: string) {
    const { root, settings } = this.services
    for (const { name } of await this.sourceDirectory(plan, sourceRoot, 'themes', 'theme')) {
      if (!name.endsWith('.json')) continue
      const filename = `themes/${name}`
      const info = { id: `theme:${name}`, category: 'theme', name, source: filename } as const
      try {
        const raw = await readConfigFile(sourceRoot, filename)
        if (raw === undefined) continue
        const theme = convertPiTheme(name, readObject(raw, filename))
        const target = path.join(storage.themesDirectory, `${theme.id}.json`)
        const content = `${JSON.stringify(theme, null, 2)}\n`
        await plan.add(
          { ...info, name: theme.name },
          theme,
          displayText(JSON.stringify(theme.colors, null, 2)),
          async () => {
            const existing = await readConfigFile(root, target)
            if (existing === undefined && settings.snapshot().themes.some(({ id }) => id === theme.id))
              throw new Error('此主题名称已由另一个主题使用')
            const value = existing === undefined ? undefined : readObject(existing, '现有主题')
            return {
              existing,
              value,
              before: value && displayText(JSON.stringify(value.colors, null, 2)),
              backup: existing === undefined ? undefined : { label: target, value: existing },
            }
          },
          ({ existing }) => replaceConfigFile(root, target, existing, content),
        )
      } catch (cause) {
        plan.block(info, reason(cause))
      }
    }
  }

  private async shortcuts(plan: MigrationPlan, sourceRoot: string) {
    const values = await this.sourceObject(plan, sourceRoot, 'keybindings.json', 'shortcut')
    if (!values) return
    const { shortcuts } = this.services
    const targets = new Set<string>()
    for (const [action, raw] of Object.entries(values).sort(
      ([left], [right]) => Number(right.startsWith('app.')) - Number(left.startsWith('app.')),
    )) {
      const mapped = piShortcut(action, raw, shortcuts.platform)
      if (!mapped) continue
      const [id, name] = mapped.target
      if (targets.has(id)) continue
      targets.add(id)
      const info = { id: `shortcut:${id}`, category: 'shortcut', name, source: 'keybindings.json' } as const
      if ('error' in mapped || mapped.binding === undefined) {
        plan.block(info, mapped.error ?? '快捷键无效')
        continue
      }
      const { binding } = mapped
      const definition = SHORTCUT_DEFINITIONS.find((entry) => entry.id === id)!
      const display = (value: string | null) => (value ? formatKeybindingDisplay(value, shortcuts.platform) : '无绑定')
      await plan.add(
        info,
        binding,
        display(binding),
        async () => {
          const preferences = await shortcuts.read()
          const current = resolveKeybinding(definition, preferences.overrides)
          return {
            preferences,
            value: current,
            before: display(current),
            backup: { label: `快捷键/${id}`, value: preferences },
          }
        },
        async ({ preferences }) => {
          const conflict = SHORTCUT_DEFINITIONS.some(
            (entry) => entry.id !== id && keybindingsConflict(binding, resolveKeybinding(entry, preferences.overrides)),
          )
          if (conflict) throw new Error('该按键已绑定到其他 Pi meme 操作，请在快捷键设置中处理冲突')
          await shortcuts.save({ ...preferences, overrides: { ...preferences.overrides, [id]: binding } }, preferences)
        },
      )
    }
    if (Object.keys(values).length > targets.size)
      plan.block(
        { id: 'shortcut:cli', category: 'shortcut', name: 'Pi CLI 专用快捷键', source: 'keybindings.json' },
        '终端专用操作没有对应的 Pi meme 快捷键',
      )
  }
}
