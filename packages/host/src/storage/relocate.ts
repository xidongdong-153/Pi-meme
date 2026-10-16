import { readdir, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { workspaceKey } from '@pi-meme/pi-runtime/runtime-paths'
import { resourceIdentity } from '@pi-meme/resources/server/resource-identity'
import { contains, listFiles, optionalStat, physicalPath, readJson, writeJson, writeText } from './files'

type RecordValue = Record<string, unknown>
function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('迁移元数据必须是对象')
  return value as RecordValue
}
function records(value: unknown): RecordValue[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('迁移元数据列表格式无效')
  return value.map(record)
}
export type WorktreeRelocation = { from: string; to: string; repository: string }

/** 只重写可执行定位字段；正文、凭据和未知插件数据不作字符串替换。 */
export async function relocateStorage(oldRoot: string, root: string) {
  const cwds = new Map<string, string>()
  const original = (value: string) => (contains(root, value) ? path.join(oldRoot, path.relative(root, value)) : value)
  const rootPath = (value: string) =>
    contains(oldRoot, value) ? path.join(root, path.relative(oldRoot, value)) : value
  const addCwd = (value: unknown) => {
    if (typeof value !== 'string' || !path.isAbsolute(value)) return
    const old = original(value)
    if (contains(oldRoot, old)) cwds.set(old, rootPath(old))
  }
  const sessionsRoot = await physicalPath(root, 'sessions')
  const sessionFiles = sessionsRoot ? (await listFiles(sessionsRoot)).filter((file) => file.endsWith('.jsonl')) : []
  for (const file of sessionFiles) {
    const first = (await readFile(file, 'utf8')).split('\n')[0]
    const header = record(JSON.parse(first))
    if (header.type !== 'session') throw new Error(`会话头部无效：${file}`)
    addCwd(header.cwd)
  }
  const documents = new Map<string, RecordValue>()
  for (const name of ['projects.json', 'settings.json', 'control.json', 'collaboration.json', 'resources/state.json']) {
    const file = await physicalPath(root, name)
    if (file) documents.set(name, record(await readJson(file)))
  }
  const projects = documents.get('projects.json')
  const control = documents.get('control.json')
  const collaboration = documents.get('collaboration.json')
  for (const entry of [
    ...records(projects?.projects),
    ...records(projects?.worktrees),
    ...records(control?.projects),
    ...records(control?.sessions),
  ])
    addCwd(entry.cwd)
  for (const entry of records(collaboration?.records)) addCwd(record(entry.summary).cwd)
  const hashes = new Map([...cwds].map(([from, to]) => [workspaceKey(from), workspaceKey(to)]))
  const relocatePath = (value: string) => {
    if (!path.isAbsolute(value)) return value
    const mapped = rootPath(value)
    const parts = path.relative(root, mapped).split(path.sep)
    if (['sessions', 'workspaces'].includes(parts[0]) && hashes.has(parts[1])) {
      parts[1] = hashes.get(parts[1])!
      return path.join(root, ...parts)
    }
    return mapped
  }
  const fields = (entry: RecordValue, names: string[]) => {
    for (const name of names) if (typeof entry[name] === 'string') entry[name] = relocatePath(entry[name] as string)
  }
  const worktrees: WorktreeRelocation[] = []
  for (const entry of records(projects?.worktrees)) {
    if (typeof entry.checkoutRoot !== 'string' || typeof entry.sourceProjectCwd !== 'string')
      throw new Error('Worktree 来源记录无效')
    const from = original(entry.checkoutRoot)
    if (contains(oldRoot, from))
      worktrees.push({ from, to: rootPath(from), repository: rootPath(original(entry.sourceProjectCwd)) })
    fields(entry, ['checkoutRoot', 'cwd', 'sourceProjectCwd'])
  }
  for (const entry of [...records(projects?.projects), ...records(control?.projects), ...records(control?.sessions)])
    fields(entry, ['cwd', 'sessionFile'])
  for (const entry of records(collaboration?.records)) {
    fields(record(entry.summary), ['cwd', 'sessionFile'])
    for (const reply of records(entry.replies)) {
      const result = record(reply.result)
      if ('agentId' in result) fields(result, ['cwd', 'sessionFile'])
      if (result.agent) fields(record(result.agent), ['cwd', 'sessionFile'])
      for (const agent of records(result.agents)) fields(agent, ['cwd', 'sessionFile'])
    }
  }
  const settings = documents.get('settings.json')
  if (settings?.pinnedPaths) {
    if (!Array.isArray(settings.pinnedPaths)) throw new Error('置顶列表格式无效')
    settings.pinnedPaths = settings.pinnedPaths.map((value) =>
      typeof value === 'string' ? relocatePath(value) : value,
    )
  }
  const itemKey = (key: string): string => {
    try {
      const tuple: unknown = JSON.parse(key)
      if (Array.isArray(tuple) && tuple.length === 3 && tuple[0] === 'local' && typeof tuple[2] === 'string')
        return JSON.stringify([tuple[0], tuple[1], relocatePath(tuple[2])])
    } catch {
      /* 非本机的历史排序键保持原样。 */
    }
    return key
  }
  if (settings?.sidebar) {
    const sidebar = record(settings.sidebar)
    if (sidebar.orders)
      sidebar.orders = Object.fromEntries(
        Object.entries(record(sidebar.orders)).map(([key, values]) => {
          if (!Array.isArray(values) || values.some((value) => typeof value !== 'string'))
            throw new Error('侧栏排序列表格式无效')
          return [key.startsWith('project:') ? `project:${itemKey(key.slice(8))}` : key, values.map(itemKey)]
        }),
      )
  }
  let resources = documents.get('resources/state.json')
  if (!resources && (await physicalPath(root, 'resources'))) {
    resources = { generation: 0, imports: [], policies: {} }
    documents.set('resources/state.json', resources)
  }
  if (resources) {
    const owners = resources.ownerIds ? record(resources.ownerIds) : {}
    const roots = [
      'skills',
      'builtin-resources/skills',
      ...[...cwds.keys()].map((cwd) => path.join(path.relative(oldRoot, cwd), '.agents/skills')),
    ]
    for (const relative of roots) {
      const directory = await physicalPath(root, relative)
      if (!directory) continue
      for (const name of await readdir(directory)) {
        if (name.startsWith('.')) continue
        const key = path.join(relative, name)
        owners[key] ??= resourceIdentity(path.join(oldRoot, key))
      }
    }
    resources.ownerIds = owners
    for (const entry of records(resources.imports)) fields(entry, ['directory', 'sourcePath'])
  }
  const pluginFile = await physicalPath(root, 'plugins/installed.json')
  if (pluginFile) {
    const plugins = records(await readJson(pluginFile))
    for (const plugin of plugins) fields(plugin, ['directory', 'sourceDirectory'])
    await writeJson(pluginFile, plugins)
  }
  for (const file of sessionFiles) {
    const content = await readFile(file, 'utf8')
    const lines = content.split('\n').map((line) => {
      if (!line.trim()) return line
      const entry = record(JSON.parse(line))
      if (entry.type === 'session') fields(entry, ['cwd', 'parentSession'])
      else if (entry.type === 'custom' && entry.customType === 'pi-meme.skill-use') fields(record(entry.data), ['path'])
      else return line
      return JSON.stringify(entry)
    })
    await writeText(file, lines.join('\n'))
  }
  const permissionsFile = await physicalPath(root, 'agent-permissions.json')
  if (permissionsFile) {
    const permissions = record(await readJson(permissionsFile))
    await writeJson(
      permissionsFile,
      Object.fromEntries(Object.entries(permissions).map(([key, value]) => [relocatePath(key), value])),
    )
  }
  for (const [name, value] of documents) await writeJson(path.join(root, name), value)
  for (const folder of ['sessions', 'workspaces']) {
    for (const [from, to] of hashes) {
      if (from === to) continue
      const source = await physicalPath(root, path.join(folder, from))
      if (!source) continue
      const destination = path.join(root, folder, to)
      if (await optionalStat(destination)) throw new Error(`迁移后的工作区哈希冲突：${destination}`)
      await rename(source, destination)
    }
  }
  for (const name of ['sessions-cache.json', 'sessions-cache.json.tmp']) {
    const file = await physicalPath(root, name)
    if (file) await rm(file)
  }
  return {
    worktrees,
    pathMappings: [...hashes].flatMap(([from, to]) =>
      ['sessions', 'workspaces'].map((folder) => [path.join(folder, from), path.join(folder, to)] as const),
    ),
  }
}
