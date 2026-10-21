import { readdir, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { workspaceKey } from '@pi-meme/pi-runtime/runtime-paths'
import { resourceIdentity } from '@pi-meme/resources/server/resource-identity'
import { attachmentReferencesHeading, messageAttachmentParts } from '@pi-meme/contracts/chat-attachments'
import { storageLayoutRelativePaths } from '@pi-meme/contracts/storage-paths'
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

export function relocateAttachmentBlock(text: string, relocatePath: (value: string) => string): string {
  if (typeof text !== 'string') return text
  const parts = messageAttachmentParts(text)
  if (!parts.attachments.length) return text
  let changed = false
  const updated = parts.attachments.map((att) => {
    const next = relocatePath(att.path)
    if (next !== att.path) changed = true
    return { name: att.name, path: next }
  })
  if (!changed) return text
  const references = `${attachmentReferencesHeading}\n${updated
    .map(({ name, path: itemPath }) => `- ${JSON.stringify(name)}：${JSON.stringify(itemPath)}`)
    .join('\n')}`
  return [parts.text, references].filter(Boolean).join('\n\n')
}

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

  // 1. 查找所有 session jsonl 文件（优先新布局 data/sessions，兼顾 sessions）
  const sessionsRoots = [
    await physicalPath(root, storageLayoutRelativePaths.sessionsDataDirectory),
    await physicalPath(root, 'sessions'),
  ].filter((dir): dir is string => Boolean(dir))
  const sessionFiles: string[] = []
  for (const dir of sessionsRoots) {
    sessionFiles.push(...(await listFiles(dir)).filter((file) => file.endsWith('.jsonl')))
  }
  for (const file of sessionFiles) {
    const first = (await readFile(file, 'utf8')).split('\n')[0]
    if (!first?.trim()) continue
    const header = record(JSON.parse(first))
    if (header.type !== 'session') throw new Error(`会话头部无效：${file}`)
    addCwd(header.cwd)
  }

  // 2. 加载文档
  const documents = new Map<string, RecordValue>()
  const docCandidates = [
    storageLayoutRelativePaths.projectsFile,
    'projects.json',
    storageLayoutRelativePaths.appConfigFile,
    'settings.json',
    storageLayoutRelativePaths.controlSnapshotFile,
    'control.json',
    'collaboration.json',
    storageLayoutRelativePaths.resourcesFile,
    'resources/state.json',
  ]
  for (const name of docCandidates) {
    const file = await physicalPath(root, name)
    if (file) documents.set(name, record(await readJson(file)))
  }

  const projects = documents.get(storageLayoutRelativePaths.projectsFile) ?? documents.get('projects.json')
  const control = documents.get(storageLayoutRelativePaths.controlSnapshotFile) ?? documents.get('control.json')
  const collaboration = documents.get('collaboration.json')

  // 协作分片目录
  const collabRootsDir = await physicalPath(root, storageLayoutRelativePaths.collaborationRootsDirectory)
  const collabRootFiles = collabRootsDir
    ? (await readdir(collabRootsDir))
        .filter((file) => file.endsWith('.json') && !file.startsWith('.'))
        .map((file) => path.join(collabRootsDir, file))
    : []
  const collabPartitions = new Map<string, RecordValue>()
  for (const file of collabRootFiles) {
    collabPartitions.set(file, record(await readJson(file)))
  }

  for (const entry of [
    ...records(projects?.projects),
    ...records(projects?.worktrees),
    ...records(control?.projects),
    ...records(control?.sessions),
  ])
    addCwd(entry.cwd)
  for (const entry of records(collaboration?.records)) addCwd(record(entry.summary).cwd)
  for (const partition of collabPartitions.values()) {
    for (const entry of records(partition.records)) addCwd(record(entry.summary).cwd)
  }

  const hashes = new Map([...cwds].map(([from, to]) => [workspaceKey(from), workspaceKey(to)]))
  const relocatePath = (value: string) => {
    if (!path.isAbsolute(value)) return value
    const mapped = rootPath(value)
    const relative = path.relative(root, mapped)
    const parts = relative.split(path.sep)
    if (['sessions', 'workspaces'].includes(parts[0]) && hashes.has(parts[1])) {
      parts[1] = hashes.get(parts[1])!
      return path.join(root, ...parts)
    }
    if (
      parts.length >= 3 &&
      ((parts[0] === 'data' && parts[1] === 'sessions') || (parts[0] === 'config' && parts[1] === 'workspaces')) &&
      hashes.has(parts[2])
    ) {
      parts[2] = hashes.get(parts[2])!
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
  for (const partition of collabPartitions.values()) {
    for (const entry of records(partition.records)) {
      fields(record(entry.summary), ['cwd', 'sessionFile'])
      for (const reply of records(entry.replies)) {
        const result = record(reply.result)
        if ('agentId' in result) fields(result, ['cwd', 'sessionFile'])
        if (result.agent) fields(record(result.agent), ['cwd', 'sessionFile'])
        for (const agent of records(result.agents)) fields(agent, ['cwd', 'sessionFile'])
      }
    }
  }

  const settings = documents.get(storageLayoutRelativePaths.appConfigFile) ?? documents.get('settings.json')
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

  let resources = documents.get(storageLayoutRelativePaths.resourcesFile) ?? documents.get('resources/state.json')
  if (!resources && ((await physicalPath(root, 'resources')) || (await physicalPath(root, 'state')))) {
    resources = { generation: 0, imports: [], policies: {} }
    documents.set(storageLayoutRelativePaths.resourcesFile, resources)
  }
  if (resources) {
    const owners = resources.ownerIds ? record(resources.ownerIds) : {}
    const roots = [
      storageLayoutRelativePaths.skillsDirectory,
      'skills',
      storageLayoutRelativePaths.builtinSkillsDirectory,
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

  const pluginFile =
    (await physicalPath(root, storageLayoutRelativePaths.pluginsFile)) ??
    (await physicalPath(root, 'plugins/installed.json'))
  if (pluginFile) {
    const raw = await readJson(pluginFile)
    if (Array.isArray(raw)) {
      const plugins = records(raw)
      for (const plugin of plugins) fields(plugin, ['directory', 'sourceDirectory'])
      await writeJson(pluginFile, plugins)
    } else if (raw && typeof raw === 'object') {
      const state = record(raw)
      if (state.format === 'pi-meme-plugins' && state.version === 1 && Array.isArray(state.records)) {
        const plugins = records(state.records)
        for (const plugin of plugins) fields(plugin, ['directory', 'sourceDirectory'])
        state.records = plugins
        await writeJson(pluginFile, state)
      } else {
        throw new Error('已安装插件清单 schema 版本不支持')
      }
    } else {
      throw new Error('已安装插件清单格式无效')
    }
  }

  // 3. 重写 session jsonl 文件中的已知字段与正式附件块，保留未修改行不变
  for (const file of sessionFiles) {
    const content = await readFile(file, 'utf8')
    let fileChanged = false
    const lines = content.split('\n').map((line) => {
      if (!line.trim()) return line
      const entry = record(JSON.parse(line))
      let lineChanged = false
      if (entry.type === 'session') {
        const oldCwd = entry.cwd
        const oldParent = entry.parentSession
        fields(entry, ['cwd', 'parentSession'])
        if (entry.cwd !== oldCwd || entry.parentSession !== oldParent) lineChanged = true
      } else if (entry.type === 'custom' && entry.customType === 'pi-meme.skill-use' && entry.data) {
        const dataRec = record(entry.data)
        const oldPath = dataRec.path
        fields(dataRec, ['path'])
        if (dataRec.path !== oldPath) lineChanged = true
      } else if (entry.type === 'message' && entry.message && typeof entry.message === 'object') {
        const msg = record(entry.message)
        if (typeof msg.content === 'string') {
          const updated = relocateAttachmentBlock(msg.content, relocatePath)
          if (updated !== msg.content) {
            msg.content = updated
            lineChanged = true
          }
        } else if (Array.isArray(msg.content)) {
          let partsChanged = false
          const updatedParts = (msg.content as unknown[]).map((part) => {
            if (part && typeof part === 'object' && typeof (part as RecordValue).text === 'string') {
              const oldText = (part as RecordValue).text as string
              const newText = relocateAttachmentBlock(oldText, relocatePath)
              if (newText !== oldText) {
                partsChanged = true
                return { ...part, text: newText }
              }
            }
            return part
          })
          if (partsChanged) {
            msg.content = updatedParts
            lineChanged = true
          }
        }
      } else if (entry.type === 'context_edit' && entry.replacement && typeof entry.replacement === 'object') {
        const repl = record(entry.replacement)
        if (typeof repl.content === 'string') {
          const updated = relocateAttachmentBlock(repl.content, relocatePath)
          if (updated !== repl.content) {
            repl.content = updated
            lineChanged = true
          }
        } else if (Array.isArray(repl.content)) {
          let partsChanged = false
          const updatedParts = (repl.content as unknown[]).map((part) => {
            if (part && typeof part === 'object' && typeof (part as RecordValue).text === 'string') {
              const oldText = (part as RecordValue).text as string
              const newText = relocateAttachmentBlock(oldText, relocatePath)
              if (newText !== oldText) {
                partsChanged = true
                return { ...part, text: newText }
              }
            }
            return part
          })
          if (partsChanged) {
            repl.content = updatedParts
            lineChanged = true
          }
        }
      }
      if (lineChanged) {
        fileChanged = true
        return JSON.stringify(entry)
      }
      return line
    })
    if (fileChanged) {
      await writeText(file, lines.join('\n'))
    }
  }

  // 4. 重写 control events.jsonl 与 operations.jsonl 中的实体引用
  const eventsFile = await physicalPath(root, storageLayoutRelativePaths.controlEventsFile)
  if (eventsFile) {
    const content = await readFile(eventsFile, 'utf8')
    let changed = false
    const lines = content.split('\n').map((line) => {
      if (!line.trim()) return line
      const entry = record(JSON.parse(line))
      let lineChanged = false
      const applyMutation = (mut: RecordValue) => {
        if (mut.kind === 'project_upsert' && mut.project) {
          const oldCwd = (mut.project as RecordValue).cwd
          fields(record(mut.project), ['cwd'])
          if ((mut.project as RecordValue).cwd !== oldCwd) lineChanged = true
        } else if (mut.kind === 'session_upsert' && mut.session) {
          const sess = record(mut.session)
          const oldCwd = sess.cwd
          const oldFile = sess.sessionFile
          fields(sess, ['cwd', 'sessionFile'])
          if (sess.cwd !== oldCwd || sess.sessionFile !== oldFile) lineChanged = true
        } else if (mut.kind === 'receipt_upsert' && mut.receipt) {
          const rec = record(mut.receipt)
          if (rec.session && typeof rec.session === 'object') {
            const s = record(rec.session)
            const oldFile = s.sessionFile
            fields(s, ['sessionFile'])
            if (s.sessionFile !== oldFile) lineChanged = true
          }
        } else if (mut.kind === 'session_receipt_upsert') {
          if (mut.session) {
            const sess = record(mut.session)
            const oldCwd = sess.cwd
            const oldFile = sess.sessionFile
            fields(sess, ['cwd', 'sessionFile'])
            if (sess.cwd !== oldCwd || sess.sessionFile !== oldFile) lineChanged = true
          }
          if (mut.receipt && typeof mut.receipt === 'object') {
            const rec = record(mut.receipt)
            if (rec.session && typeof rec.session === 'object') {
              const s = record(rec.session)
              const oldFile = s.sessionFile
              fields(s, ['sessionFile'])
              if (s.sessionFile !== oldFile) lineChanged = true
            }
          }
        }
      }
      if (entry.mutation && typeof entry.mutation === 'object') {
        applyMutation(record(entry.mutation))
      }
      if (Array.isArray(entry.mutations)) {
        for (const m of entry.mutations) {
          if (m && typeof m === 'object') applyMutation(record(m))
        }
      }
      if (entry.event && typeof entry.event === 'object') {
        const ev = record(entry.event)
        if (ev.value && typeof ev.value === 'object') {
          const val = record(ev.value)
          if (typeof val.cwd === 'string' || typeof val.sessionFile === 'string') {
            const oldCwd = val.cwd
            const oldFile = val.sessionFile
            fields(val, ['cwd', 'sessionFile'])
            if (val.cwd !== oldCwd || val.sessionFile !== oldFile) lineChanged = true
          }
        }
      }
      if (lineChanged) {
        changed = true
        return JSON.stringify(entry)
      }
      return line
    })
    if (changed) {
      await writeText(eventsFile, lines.join('\n'))
    }
  }

  const opsFile = await physicalPath(root, storageLayoutRelativePaths.controlOperationsFile)
  if (opsFile) {
    const content = await readFile(opsFile, 'utf8')
    let changed = false
    const lines = content.split('\n').map((line) => {
      if (!line.trim()) return line
      const entry = record(JSON.parse(line))
      let lineChanged = false
      if (entry.result && typeof entry.result === 'object') {
        const res = record(entry.result)
        if (typeof res.cwd === 'string' || typeof res.sessionFile === 'string') {
          const oldCwd = res.cwd
          const oldFile = res.sessionFile
          fields(res, ['cwd', 'sessionFile'])
          if (res.cwd !== oldCwd || res.sessionFile !== oldFile) lineChanged = true
        }
        if (res.session && typeof res.session === 'object') {
          const s = record(res.session)
          const oldFile = s.sessionFile
          fields(s, ['sessionFile'])
          if (s.sessionFile !== oldFile) lineChanged = true
        }
        if (res.project && typeof res.project === 'object') {
          const p = record(res.project)
          const oldCwd = p.cwd
          fields(p, ['cwd'])
          if (p.cwd !== oldCwd) lineChanged = true
        }
      }
      if (lineChanged) {
        changed = true
        return JSON.stringify(entry)
      }
      return line
    })
    if (changed) {
      await writeText(opsFile, lines.join('\n'))
    }
  }

  // 5. 权限文件
  const permissionsFile =
    (await physicalPath(root, storageLayoutRelativePaths.agentPermissionsFile)) ??
    (await physicalPath(root, 'agent-permissions.json'))
  if (permissionsFile) {
    const permissions = record(await readJson(permissionsFile))
    await writeJson(
      permissionsFile,
      Object.fromEntries(Object.entries(permissions).map(([key, value]) => [relocatePath(key), value])),
    )
  }

  for (const [name, value] of documents) await writeJson(path.join(root, name), value)
  for (const [file, value] of collabPartitions) await writeJson(file, value)

  const foldersToRename = [
    storageLayoutRelativePaths.sessionsDataDirectory,
    'sessions',
    storageLayoutRelativePaths.workspacesConfigDirectory,
    'workspaces',
  ]
  for (const folder of foldersToRename) {
    for (const [from, to] of hashes) {
      if (from === to) continue
      const source = await physicalPath(root, path.join(folder, from))
      if (!source) continue
      const destination = path.join(root, folder, to)
      if (await optionalStat(destination)) throw new Error(`迁移后的工作区哈希冲突：${destination}`)
      await rename(source, destination)
    }
  }

  for (const name of [
    storageLayoutRelativePaths.sessionsCacheFile,
    `${storageLayoutRelativePaths.sessionsCacheFile}.tmp`,
    'sessions-cache.json',
    'sessions-cache.json.tmp',
  ]) {
    const file = await physicalPath(root, name)
    if (file) await rm(file)
  }

  return {
    worktrees,
    pathMappings: [...hashes].flatMap(([from, to]) =>
      foldersToRename.map((folder) => [path.join(folder, from), path.join(folder, to)] as const),
    ),
  }
}
