import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { loadPiSdk } from '@pi-meme/pi-runtime/sdk/load'
import type {
  ResourceAppPackage,
  ResourceCatalog,
  ResourceImportInput,
  ResourceInvocation,
  ResourceItem,
  ResourceOwner,
  ResourcePolicy,
  ResourcePolicyInput,
  ResourceScope,
  ResourceSkillSaveInput,
  ResourceSnapshot,
} from '@pi-meme/contracts/resources'
import { resourceIdentity as identity } from './resource-identity'
import {
  materializeResource,
  readResourceFiles,
  resourceRevision,
  resourceSizeLimit,
  safeRelative,
  unzipResource,
  type ResourceFile,
} from './resource-files'
import { storageLayoutRelativePaths } from '@pi-meme/contracts/storage-paths'

type ImportRecord = {
  id: string
  kind: 'skill'
  directory: string
  sourcePath: string
  name: string
}
type Policy = ResourcePolicy
type StoreState = {
  generation: number
  imports: ImportRecord[]
  policies: Record<string, Policy>
  /** 迁移时保留原路径身份，键相对于数据根目录。 */
  ownerIds?: Record<string, string>
}
export type ResourceStoreOptions = {
  hostId?: string
  getAppPackages?: () => ResourceAppPackage[] | Promise<ResourceAppPackage[]>
  onChange?: (generation: number) => void | Promise<void>
}
async function exists(value: string) {
  try {
    await lstat(value)
    return true
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw cause
  }
}
function isInside(root: string, value: string) {
  const relative = path.relative(root, value)
  return !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
}
async function canonicalCwd(cwd: string) {
  const resolved = path.resolve(cwd)
  try {
    return await realpath(resolved)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return resolved
    throw cause
  }
}
function skillName(value: unknown) {
  if (typeof value !== 'string' || !/^[a-z\d][a-z\d-]{0,63}$/.test(value))
    throw new Error('技能名称必须是 1 至 64 位小写字母、数字或连字符')
  return value
}
function isAppPackageEnabled(
  app: ResourceAppPackage,
  state: StoreState,
  projectPolicies: Record<string, Policy>,
): boolean {
  const appPolicy = projectPolicies[`app:${app.id}`]
  return app.enabled && (appPolicy?.enabled ?? state.policies[`host:app:${app.id}`]?.enabled ?? true)
}
export class ResourceStore {
  readonly dataRoot: string
  readonly stateFile: string
  readonly skillsDirectory: string
  readonly builtinSkillsDirectory: string
  readonly snapshotsDirectory: string
  readonly workspacesConfigDirectory: string
  private state?: StoreState
  private pending: Promise<unknown> = Promise.resolve()
  private writes: Promise<unknown> = Promise.resolve()
  private policyReads = new Set<Promise<unknown>>()
  private projectPolicyCache = new Map<string, Promise<Record<string, Policy>>>()
  private pendingCount = 0
  assertIdle() {
    if (this.pendingCount) throw new Error('资源仍有操作正在执行，请稍后再维护存储')
  }
  private readonly leases = new Map<string, number>()
  constructor(
    root: string,
    private readonly options: ResourceStoreOptions = {},
  ) {
    this.dataRoot = path.resolve(root)
    this.stateFile = path.join(this.dataRoot, storageLayoutRelativePaths.resourcesFile)
    this.skillsDirectory = path.join(this.dataRoot, storageLayoutRelativePaths.skillsDirectory)
    this.builtinSkillsDirectory = path.join(this.dataRoot, storageLayoutRelativePaths.builtinSkillsDirectory)
    this.snapshotsDirectory = path.join(this.dataRoot, storageLayoutRelativePaths.snapshotsDirectory)
    this.workspacesConfigDirectory = path.join(this.dataRoot, storageLayoutRelativePaths.workspacesConfigDirectory)
  }
  init(): Promise<void> {
    return this.serialize(async () => {
      await this.initialize()
    }, true)
  }
  async waitForIdle(): Promise<void> {
    await Promise.all([this.pending, ...this.policyReads])
  }
  acquire(snapshot: ResourceSnapshot) {
    this.leases.set(snapshot.id, (this.leases.get(snapshot.id) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const remaining = (this.leases.get(snapshot.id) ?? 1) - 1
      if (remaining) this.leases.set(snapshot.id, remaining)
      else this.leases.delete(snapshot.id)
    }
  }
  private serialize<T>(action: () => Promise<T>, mutation = false): Promise<T> {
    this.pendingCount++
    const result = this.pending.then(action).finally(() => {
      this.pendingCount--
    })
    this.pending = result.catch(() => {})
    if (mutation) this.writes = this.pending
    return result
  }
  private async initialize() {
    if (this.state) return this.state
    for (const directory of [
      this.skillsDirectory,
      this.builtinSkillsDirectory,
      this.snapshotsDirectory,
      path.dirname(this.stateFile),
    ])
      await mkdir(directory, { recursive: true })
    try {
      const state = JSON.parse(await readFile(this.stateFile, 'utf8')) as StoreState
      if (!Number.isSafeInteger(state.generation) || !Array.isArray(state.imports) || !state.policies)
        throw new Error('资源状态格式错误')
      this.state = { ...state, imports: state.imports.filter((record) => record.kind === 'skill') }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
      this.state = { generation: 0, imports: [], policies: {} }
    }
    return this.state
  }
  private async persistState(next: StoreState) {
    await mkdir(path.dirname(this.stateFile), { recursive: true })
    const temporary = path.join(path.dirname(this.stateFile), `.state-${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx' })
      await rename(temporary, this.stateFile)
    } finally {
      await rm(temporary, { force: true })
    }
  }
  private async commit(next: StoreState) {
    const previous = await this.initialize()
    await this.persistState(next)
    this.state = next
    try {
      await this.options.onChange?.(next.generation)
    } catch (cause) {
      await this.persistState(previous)
      this.state = previous
      throw cause
    }
  }
  private projectPolicyPath(cwd: string) {
    return path.join(
      this.workspacesConfigDirectory,
      createHash('sha256').update(path.resolve(cwd)).digest('hex'),
      'resources.json',
    )
  }
  private async projectPolicies(cwd?: string): Promise<Record<string, Policy>> {
    if (!cwd) return {}
    cwd = await canonicalCwd(cwd)
    const cached = this.projectPolicyCache.get(cwd)
    if (cached) return cached
    const pending = readFile(this.projectPolicyPath(cwd), 'utf8').then(
      (content) => JSON.parse(content) as Record<string, Policy>,
      (cause: NodeJS.ErrnoException) => {
        if (cause.code === 'ENOENT') return {}
        throw cause
      },
    )
    this.projectPolicyCache.set(cwd, pending)
    try {
      return await pending
    } catch (cause) {
      if (this.projectPolicyCache.get(cwd) === pending) this.projectPolicyCache.delete(cwd)
      throw cause
    }
  }
  private async publish(directory: string, files: ResourceFile[], next: StoreState) {
    const parent = path.dirname(directory)
    await mkdir(parent, { recursive: true })
    const staging = path.join(parent, `.stage-${randomUUID()}`)
    const backup = path.join(parent, `.backup-${randomUUID()}`)
    const targetIsFile = (await exists(directory)) && (await lstat(directory)).isFile()
    if (!targetIsFile) await mkdir(staging)
    let replaced = false
    let published = false
    let committed = false
    try {
      if (targetIsFile) {
        if (files.length !== 1) throw new Error('单文件资源不能包含其他文件')
        await writeFile(staging, files[0].content, { mode: files[0].mode ?? 0o644 })
        await chmod(staging, files[0].mode ?? 0o644)
      } else
        for (const file of files) {
          const output = path.join(staging, safeRelative(file.path))
          await mkdir(path.dirname(output), { recursive: true })
          await writeFile(output, file.content, { mode: file.mode ?? 0o644 })
          await chmod(output, file.mode ?? 0o644)
        }
      if (await exists(directory)) {
        await rename(directory, backup)
        replaced = true
      }
      await rename(staging, directory)
      published = true
      await this.commit(next)
      committed = true
    } catch (cause) {
      if (published) await rm(directory, { recursive: true, force: true })
      if (replaced) {
        await rename(backup, directory)
        replaced = false
      }
      throw cause
    } finally {
      await rm(staging, { recursive: true, force: true })
      if (committed || !replaced) await rm(backup, { recursive: true, force: true })
    }
  }
  private async freeze(source: string) {
    const files = await readResourceFiles(source)
    return {
      files,
      directory: await materializeResource(this.snapshotsDirectory, files),
      revision: resourceRevision(files),
    }
  }
  private async skillInterface(directory: string) {
    const metadata: { displayName?: string; shortDescription?: string; manual: boolean; diagnostics: string[] } = {
      manual: false,
      diagnostics: [],
    }
    const file = path.join(directory, 'agents/openai.yaml')
    if (!(await exists(file))) return metadata
    const diagnose = (message: string) => metadata.diagnostics.push(`${file}：${message}`)
    try {
      const { parseFrontmatter } = await loadPiSdk()
      const content = await readFile(file, 'utf8')
      const { frontmatter, body } = parseFrontmatter(`---\n${content}\n---`)
      if (body || !frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter))
        throw new Error('YAML 必须是单个字段映射')
      const record = frontmatter as Record<string, unknown>
      for (const key of ['interface', 'policy']) {
        const value = record[key]
        if (value === undefined) continue
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          diagnose(`${key} 必须是字段映射`)
          if (key === 'policy') metadata.manual = true
          continue
        }
        const fields = value as Record<string, unknown>
        if (key === 'interface') {
          for (const [field, target] of [
            ['display_name', 'displayName'],
            ['short_description', 'shortDescription'],
          ] as const) {
            if (fields[field] === undefined) continue
            if (typeof fields[field] !== 'string' || !fields[field].trim())
              diagnose(`interface.${field} 必须是非空字符串`)
            else metadata[target] = fields[field]
          }
        } else if (fields.allow_implicit_invocation !== undefined) {
          if (typeof fields.allow_implicit_invocation !== 'boolean') {
            diagnose('policy.allow_implicit_invocation 必须是布尔值')
            metadata.manual = true
          } else metadata.manual = !fields.allow_implicit_invocation
        }
      }
    } catch (cause) {
      diagnose(`YAML 解析失败：${cause instanceof Error ? cause.message : String(cause)}`)
      metadata.manual = true
    }
    return metadata
  }
  private async scan(cwd?: string): Promise<ResourceCatalog> {
    const { loadSkills, parseFrontmatter } = await loadPiSdk()
    if (cwd) cwd = await canonicalCwd(cwd)
    const state = await this.initialize()
    const projectPolicies = await this.projectPolicies(cwd)
    const items: ResourceItem[] = []
    const diagnostics: string[] = []
    const addRoot = async (
      source: string,
      scope: ResourceScope,
      owner: ResourceOwner,
      enabled = true,
      declared?: { skills?: string[]; themes?: string[]; assets?: string[] },
    ) => {
      try {
        const frozen = await this.freeze(source)
        const root = frozen.directory
        const sourceIsFile = (await lstat(source)).isFile()
        const relativeSource = sourceIsFile ? path.basename(source) : ''
        const fileSource = (relative: string) => (sourceIsFile ? source : path.join(source, relative))
        const base = (entry: {
          kind: 'skill'
          name: string
          filePath: string
          baseDir: string
          description?: string
          invocation?: ResourceInvocation
          diagnostics?: string[]
        }): ResourceItem => {
          const relative = path.relative(root, entry.filePath)
          const name = owner.type === 'app-package' ? `${owner.name ?? owner.id}:${entry.name}` : entry.name
          const id = identity(`${this.options.hostId ?? this.dataRoot}:${scope}:${owner.id}:${entry.kind}:${relative}`)
          const hostPolicy = state.policies[`host:${id}`]
          const projectPolicy = projectPolicies[id]
          return {
            id,
            kind: entry.kind,
            name,
            description: entry.description,
            revision: frozen.revision,
            path: entry.filePath,
            sourcePath: fileSource(relative),
            baseDir: entry.baseDir,
            scope,
            owner,
            enabled: enabled && (projectPolicy?.enabled ?? hostPolicy?.enabled ?? true),
            defaultPolicy: { enabled, invocation: entry.invocation ?? 'automatic' },
            hostPolicy: hostPolicy ? { ...hostPolicy } : undefined,
            projectPolicy: projectPolicy ? { ...projectPolicy } : undefined,
            invocation: projectPolicy?.invocation ?? hostPolicy?.invocation ?? entry.invocation ?? 'automatic',
            diagnostics: entry.diagnostics ?? [],
            editable: scope === 'host' && owner.type === 'loose' && entry.kind === 'skill',
          }
        }
        const skillPaths = declared
          ? (declared.skills ?? []).map((value) => path.join(root, safeRelative(value)))
          : [relativeSource ? path.join(root, relativeSource) : root]
        for (const location of skillPaths) if (!isInside(root, location)) throw new Error('包资源路径超出资源目录')
        for (const location of skillPaths) {
          const loaded = loadSkills({ cwd: root, agentDir: root, skillPaths: [location], includeDefaults: false })
          for (const diagnostic of loaded.diagnostics) {
            diagnostics.push(`${source}：${diagnostic.message}`)
            const existing = loaded.skills.find((skill) => skill.filePath === diagnostic.path)
            if (!existing && diagnostic.path && isInside(root, diagnostic.path) && diagnostic.type === 'error') {
              const invalid = base({
                kind: 'skill',
                name: path.basename(path.dirname(diagnostic.path)),
                filePath: diagnostic.path,
                baseDir: path.dirname(diagnostic.path),
                diagnostics: [diagnostic.message],
              })
              invalid.enabled = false
              items.push(invalid)
            }
          }
          for (const skill of loaded.skills) {
            const content = await readFile(skill.filePath, 'utf8')
            const { frontmatter } = parseFrontmatter(content)
            const interfaceMetadata = await this.skillInterface(skill.baseDir)
            const item = base({
              kind: 'skill',
              name: skill.name,
              filePath: skill.filePath,
              baseDir: skill.baseDir,
              description: skill.description,
              invocation: skill.disableModelInvocation || interfaceMetadata.manual ? 'manual' : 'automatic',
            })
            item.diagnostics.push(
              ...interfaceMetadata.diagnostics,
              ...loaded.diagnostics
                .filter((diagnostic) => diagnostic.path === skill.filePath)
                .map((diagnostic) => diagnostic.message),
            )
            const metadata =
              frontmatter.metadata && typeof frontmatter.metadata === 'object' && !Array.isArray(frontmatter.metadata)
                ? (frontmatter.metadata as Record<string, unknown>)
                : {}
            const displayName = interfaceMetadata.displayName ?? metadata['display-name'] ?? frontmatter['display-name']
            const shortDescription =
              interfaceMetadata.shortDescription ?? metadata['short-description'] ?? frontmatter['short-description']
            if (typeof displayName === 'string') item.displayName = displayName
            if (typeof shortDescription === 'string') item.shortDescription = shortDescription
            items.push(item)
          }
        }
      } catch (cause) {
        diagnostics.push(`${source}：${cause instanceof Error ? cause.message : String(cause)}`)
      }
    }
    const loose = async (directory: string, scope: ResourceScope) => {
      if (!(await exists(directory))) return
      for (const entry of (await readdir(directory)).sort()) {
        if (entry.startsWith('.')) continue
        const source = path.join(directory, entry)
        const owner: ResourceOwner = {
          id: state.ownerIds?.[path.relative(this.dataRoot, source)] ?? identity(source),
          type: scope === 'builtin' ? 'builtin' : 'loose',
        }
        if (state.imports.some((record) => record.id === owner.id)) continue
        await addRoot(source, scope, owner)
      }
    }
    await loose(this.builtinSkillsDirectory, 'builtin')
    await loose(this.skillsDirectory, 'host')
    for (const record of state.imports) {
      await addRoot(record.directory, 'host', { id: record.id, type: 'loose', name: record.name })
    }
    if (cwd) {
      await loose(path.join(path.resolve(cwd), '.agents/skills'), 'project')
    }
    for (const app of (await this.options.getAppPackages?.()) ?? []) {
      const appPolicy = projectPolicies[`app:${app.id}`]
      const appEnabled = isAppPackageEnabled(app, state, projectPolicies)
      const owner: ResourceOwner = {
        id: app.id,
        type: 'app-package',
        name: app.id,
        version: app.version,
        generation: app.generation,
      }
      items.push({
        id: `app:${app.id}`,
        kind: 'app-plugin',
        name: app.id,
        displayName: app.display?.name,
        description: app.display?.description,
        revision: `${app.version}:${app.generation}`,
        path: app.directory,
        sourcePath: app.directory,
        baseDir: app.directory,
        scope: 'host',
        owner,
        enabled: appEnabled,
        defaultPolicy: { enabled: app.enabled, invocation: 'manual' },
        hostPolicy: state.policies[`host:app:${app.id}`] ? { ...state.policies[`host:app:${app.id}`] } : undefined,
        projectPolicy: appPolicy ? { ...appPolicy } : undefined,
        invocation: 'manual',
        diagnostics: [],
        editable: false,
      })
      if (app.resources) await addRoot(app.directory, 'host', owner, appEnabled, app.resources)
    }
    const duplicates = new Map<string, ResourceItem[]>()
    for (const item of items.filter((entry) => entry.kind === 'skill' && entry.enabled)) {
      const key = `${item.scope}:${item.name}`
      duplicates.set(key, [...(duplicates.get(key) ?? []), item])
    }
    for (const entries of duplicates.values()) {
      if (entries.length < 2) continue
      for (const item of entries) {
        item.enabled = false
        item.diagnostics.push(`同一 ${item.scope} 来源存在多个同名技能 ${item.name}；请停用重复项后刷新`)
      }
    }
    const names = new Map<string, ResourceItem>()
    const ranked = items
      .filter((item) => item.kind === 'skill' && (item.scope === 'builtin' || item.enabled))
      .sort((a, b) => {
        const ranks = { builtin: 0, project: 1, host: 2 }
        return ranks[a.scope] - ranks[b.scope]
      })
    for (const item of ranked) {
      const winner = names.get(item.name)
      if (winner) {
        item.shadowedBy = winner.id
        item.diagnostics.push(`同名技能由 ${winner.scope} 资源覆盖`)
      } else names.set(item.name, item)
    }
    return {
      hostId: this.options.hostId,
      generation: state.generation,
      cwd: cwd ? path.resolve(cwd) : undefined,
      dataRoot: this.dataRoot,
      items,
      diagnostics,
    }
  }
  catalog(cwd?: string) {
    return this.serialize(() => this.scan(cwd))
  }
  disabledAppPluginIds(cwd?: string): Promise<Set<string>> {
    this.pendingCount++
    const read = (async () => {
      if (cwd) cwd = await canonicalCwd(cwd)
      for (;;) {
        const writes = this.writes
        await writes
        const state = await this.initialize()
        const projectPolicies = await this.projectPolicies(cwd)
        const apps = (await this.options.getAppPackages?.()) ?? []
        if (writes !== this.writes) continue
        return new Set(apps.filter((app) => !isAppPackageEnabled(app, state, projectPolicies)).map((app) => app.id))
      }
    })().finally(() => {
      this.pendingCount--
      this.policyReads.delete(read)
    })
    this.policyReads.add(read)
    return read
  }
  snapshot(cwd: string): Promise<ResourceSnapshot> {
    return this.serialize(async () => {
      const catalog = await this.scan(cwd)
      const active = catalog.items.filter((item) => item.enabled && !item.shadowedBy)
      const skills = active.filter((item) => item.kind === 'skill')
      const appPlugins = catalog.items.filter((item) => item.kind === 'app-plugin')
      return {
        id: identity(
          JSON.stringify([
            catalog.cwd,
            skills.map((item) => [item.id, item.revision, item.invocation, item.owner.generation]),
            appPlugins.map((item) => [item.id, item.revision, item.enabled]),
          ]),
        ),
        generation: catalog.generation,
        cwd: catalog.cwd!,
        skills,
        appPlugins,
      }
    })
  }
  refresh(cwd?: string) {
    return this.serialize(async () => {
      if (cwd) this.projectPolicyCache.delete(await canonicalCwd(cwd))
      else this.projectPolicyCache.clear()
      const state = await this.initialize()
      const catalog = await this.scan(cwd)
      await this.commit({ ...state, generation: state.generation + 1 })
      return { ...catalog, generation: state.generation + 1 }
    }, true)
  }
  async readSkill(id: string, cwd?: string) {
    return this.serialize(async () => {
      const item = (await this.scan(cwd)).items.find((entry) => entry.id === id && entry.kind === 'skill')
      if (!item) throw new Error('技能不存在')
      return { item, content: await readFile(item.path, 'utf8') }
    })
  }
  private async importFiles(input: ResourceImportInput): Promise<{ files: ResourceFile[]; sourcePath: string }> {
    const count = [input.path, input.content, input.archiveBase64, input.files].filter(
      (value) => value !== undefined,
    ).length
    if (count !== 1) throw new Error('必须提供一种资源输入：路径、正文、ZIP 或文件列表')
    if (input.path) {
      const source = path.resolve(input.path)
      if (path.extname(source).toLowerCase() === '.zip')
        return { files: unzipResource(await readFile(source)), sourcePath: source }
      return { files: await readResourceFiles(source), sourcePath: source }
    }
    if (input.archiveBase64 !== undefined) {
      if (input.archiveBase64.length > Math.ceil(resourceSizeLimit / 3) * 4) throw new Error('上传压缩包超过 32 MiB')
      return { files: unzipResource(Buffer.from(input.archiveBase64, 'base64')), sourcePath: 'upload:zip' }
    }
    if (input.files)
      return {
        files: input.files.map((file) => ({
          path: safeRelative(file.path),
          content: Buffer.from(file.content, file.encoding ?? 'utf8'),
        })),
        sourcePath: 'upload:files',
      }
    return {
      files: [
        {
          path: 'SKILL.md',
          content: Buffer.from(input.content ?? ''),
        },
      ],
      sourcePath: 'upload:text',
    }
  }
  private async validateImport(directory: string) {
    const { loadSkills } = await loadPiSdk()
    const found = loadSkills({ cwd: directory, agentDir: directory, skillPaths: [directory], includeDefaults: false })
    if (!found.skills.length || found.diagnostics.some((item) => item.type === 'error'))
      throw new Error(`技能校验失败：${found.diagnostics.map((item) => item.message).join('；') || '没有有效技能'}`)
    return found.skills[0].name
  }
  import(input: ResourceImportInput, cwd?: string) {
    return this.serialize(async () => {
      const state = await this.initialize()
      if (input.kind !== undefined && input.kind !== 'skill') throw new Error('资源导入类型无效')
      const replaceItem = input.replace
        ? (await this.scan(cwd)).items.find((item) => item.id === input.replace?.id)
        : undefined
      if (input.replace) {
        if (!replaceItem) throw new Error('待更新资源不存在')
        if (replaceItem.scope !== 'host' || replaceItem.owner.type !== 'loose')
          throw new Error('只能更新 Host 用户技能')
        if (input.replace.revision !== replaceItem.revision) throw new Error('资源已更新，请重新读取修订后上传')
      }
      const replaceRecord = replaceItem ? state.imports.find((record) => record.id === replaceItem.owner.id) : undefined
      const replaceKind = replaceItem ? (replaceRecord?.kind ?? replaceItem.kind) : undefined
      const replaceTarget = replaceItem
        ? (replaceRecord?.directory ?? (await this.looseSource(replaceItem)))
        : undefined
      let { files, sourcePath } = await this.importFiles(input)
      if (sourcePath.startsWith('upload:') || sourcePath.endsWith('.zip')) {
        const first = files[0]?.path.split('/')[0]
        if (first && files.every((file) => file.path.startsWith(`${first}/`)))
          files = files.map((file) => ({ ...file, path: file.path.slice(first.length + 1) }))
      }
      if (!input.replace && input.name) {
        const name = skillName(input.name)
        const documents = files.filter(
          (file) => path.basename(file.path) === 'SKILL.md' || (file.path.endsWith('.md') && !file.path.includes('/')),
        )
        if (documents.length !== 1) throw new Error('复制技能必须只包含一个技能入口')
        const document = documents[0]
        const content = document.content.toString('utf8')
        if (!content.startsWith('---')) throw new Error('技能缺少 frontmatter')
        const end = content.indexOf('\n---', 3)
        if (end < 0) throw new Error('技能 frontmatter 不完整')
        const header = content.slice(0, end)
        const rewritten = /^name:/m.test(header)
          ? header.replace(/^name:.*$/m, `name: ${name}`)
          : `${header}\nname: ${name}`
        files = files.map((file) =>
          file === document ? { ...file, content: Buffer.from(`${rewritten}${content.slice(end)}`) } : file,
        )
      }
      if (!files.length) throw new Error('资源内容为空')
      const directory = await materializeResource(this.snapshotsDirectory, files)
      if (await exists(path.join(directory, 'package.json'))) {
        const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')) as {
          piMeme?: unknown
        }
        if (manifest.piMeme) throw new Error('这是应用插件，请通过应用插件安装入口导入')
      }
      const kind = 'skill' as const
      const name = await this.validateImport(directory)
      if (replaceItem) {
        if (kind !== replaceKind) throw new Error('更新资源类型与原资源不一致')
        const { loadSkills } = await loadPiSdk()
        const loaded = loadSkills({
          cwd: directory,
          agentDir: directory,
          skillPaths: [directory],
          includeDefaults: false,
        })
        const relative = path.relative(path.join(this.snapshotsDirectory, replaceItem.revision), replaceItem.path)
        const updated = loaded.skills.find((skill) => path.relative(directory, skill.filePath) === relative)
        if (
          !updated ||
          updated.name !== replaceItem.name ||
          (input.name !== undefined && input.name !== replaceItem.name)
        )
          throw new Error('更新技能的入口和名称必须与原技能一致')
      }
      const target = replaceTarget ?? path.join(this.skillsDirectory, skillName(name))
      const current = state.imports.find((record) => record.directory === target)
      if (
        !input.replace &&
        (await exists(target)) &&
        (!current || sourcePath.startsWith('upload:') || (current.sourcePath !== sourcePath && sourcePath !== target))
      )
        throw new Error('同级资源名称重复，请更换名称或更新原导入来源')
      const record: ImportRecord = {
        id: replaceItem?.owner.id ?? state.ownerIds?.[path.relative(this.dataRoot, target)] ?? identity(target),
        kind,
        directory: target,
        sourcePath,
        name,
      }
      const imports = [...state.imports.filter((entry) => entry.directory !== target), record]
      await this.publish(target, files, { ...state, imports, generation: state.generation + 1 })
      return this.scan(cwd)
    }, true)
  }
  private async looseSource(item: ResourceItem) {
    const root = this.skillsDirectory
    for (const entry of await readdir(root)) {
      const source = path.join(root, entry)
      if (
        ((await this.initialize()).ownerIds?.[path.relative(this.dataRoot, source)] ?? identity(source)) ===
        item.owner.id
      )
        return source
    }
    throw new Error('资源来源目录不存在')
  }
  remove(id: string) {
    return this.serialize(async () => {
      const state = await this.initialize()
      const item = (await this.scan()).items.find((entry) => entry.id === id)
      if (!item) throw new Error('资源不存在')
      if (item.scope !== 'host' || item.owner.type === 'app-package' || item.owner.type === 'builtin')
        throw new Error('此资源不能从资源管理器删除')
      const record = state.imports.find((entry) => entry.id === item.owner.id)
      const directory = record?.directory ?? (await this.looseSource(item))
      const backup = path.join(this.snapshotsDirectory, `.removed-${randomUUID()}`)
      await rename(directory, backup)
      try {
        await this.commit({
          ...state,
          imports: state.imports.filter((entry) => entry.id !== item.owner.id),
          generation: state.generation + 1,
        })
      } catch (cause) {
        await rename(backup, directory)
        throw cause
      }
      await rm(backup, { recursive: true, force: true })
      return this.scan()
    }, true)
  }
  saveSkill(input: ResourceSkillSaveInput, cwd?: string) {
    return this.serialize(async () => {
      const { parseFrontmatter } = await loadPiSdk()
      const state = await this.initialize()
      const item = input.id
        ? (await this.scan(cwd)).items.find((entry) => entry.id === input.id && entry.kind === 'skill')
        : undefined
      if (input.id && !item) throw new Error('技能不存在')
      if (item && !item.editable) throw new Error('项目、内置和包技能只读')
      if (item && input.revision !== item.revision) throw new Error('技能已更新，请重新读取后保存')
      const parsed = parseFrontmatter(input.content).frontmatter
      const name = skillName(input.name ?? parsed.name ?? (item ? item.name : undefined))
      if (parsed.name !== undefined && parsed.name !== name) throw new Error('技能名称与 frontmatter name 不一致')
      if (typeof parsed.description !== 'string' || !parsed.description.trim())
        throw new Error('技能必须填写 description')
      const record = item ? state.imports.find((entry) => entry.id === item.owner.id) : undefined
      const sourceDirectory = item ? path.join(this.snapshotsDirectory, item.revision) : undefined
      const files = sourceDirectory ? await readResourceFiles(sourceDirectory) : []
      const relative = item ? path.relative(sourceDirectory!, item.path) : 'SKILL.md'
      const nextFiles = files.filter((file) => file.path !== relative)
      nextFiles.push({ path: relative, content: Buffer.from(input.content) })
      const directory = await materializeResource(this.snapshotsDirectory, nextFiles)
      await this.validateImport(directory)
      const target = record?.directory ?? (item ? await this.looseSource(item) : path.join(this.skillsDirectory, name))
      if (!item && (await exists(target))) throw new Error('同级技能名称重复')
      const nextRecord: ImportRecord = {
        id: item?.owner.id ?? state.ownerIds?.[path.relative(this.dataRoot, target)] ?? identity(target),
        kind: 'skill',
        directory: target,
        sourcePath: record?.sourcePath ?? target,
        name,
      }
      const imports = [...state.imports.filter((entry) => entry.id !== nextRecord.id), nextRecord]
      await this.publish(target, nextFiles, { ...state, imports, generation: state.generation + 1 })
      return this.scan(cwd)
    }, true)
  }
  setPolicy(input: ResourcePolicyInput) {
    return this.serialize(async () => {
      if (input.cwd) input = { ...input, cwd: await canonicalCwd(input.cwd) }
      const state = await this.initialize()
      if (input.scope !== 'host' && input.scope !== 'project') throw new Error('资源策略作用域错误')
      if (input.scope === 'project' && !input.cwd) throw new Error('项目策略必须提供 cwd')
      if (input.invocation !== undefined && input.invocation !== 'automatic' && input.invocation !== 'manual')
        throw new Error('技能调用策略错误')
      const item = (await this.scan(input.cwd)).items.find((entry) => entry.id === input.id)
      if (!item) throw new Error('资源不存在')
      if (item.scope === 'project' && input.scope === 'host') throw new Error('项目资源只能设置项目策略')
      if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new Error('资源开关必须是布尔值')
      const policies = input.scope === 'project' ? await this.projectPolicies(input.cwd) : state.policies
      const key = input.scope === 'project' ? input.id : `host:${input.id}`
      if (input.reset !== undefined && typeof input.reset !== 'boolean') throw new Error('恢复默认参数必须是布尔值')
      const policy = {
        ...policies[key],
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.invocation !== undefined ? { invocation: input.invocation } : {}),
      }
      const nextPolicies = { ...policies }
      if (input.reset) delete nextPolicies[key]
      else nextPolicies[key] = policy
      if (input.scope === 'project') {
        const target = this.projectPolicyPath(input.cwd!)
        await mkdir(path.dirname(target), { recursive: true })
        const temporary = `${target}.${randomUUID()}.tmp`
        const previous = (await exists(target)) ? await readFile(target) : undefined
        try {
          await writeFile(temporary, JSON.stringify(nextPolicies))
          await rename(temporary, target)
          try {
            await this.commit({ ...state, generation: state.generation + 1 })
            this.projectPolicyCache.set(input.cwd!, Promise.resolve(nextPolicies))
          } catch (cause) {
            if (previous) {
              await writeFile(temporary, previous)
              await rename(temporary, target)
            } else await rm(target, { force: true })
            throw cause
          }
        } finally {
          await rm(temporary, { force: true })
        }
      } else
        await this.commit({
          ...state,
          policies: nextPolicies,
          generation: state.generation + 1,
        })
      return this.scan(input.cwd)
    }, true)
  }
}
