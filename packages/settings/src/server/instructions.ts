import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { storageLayoutRelativePaths } from '@pi-meme/contracts/storage-paths'
import { readDesktopAgentContextFile } from '@pi-meme/pi-runtime/sdk/context-files'
import type {
  InstructionFile,
  InstructionKind,
  InstructionsSnapshot,
  SaveInstruction,
} from '@pi-meme/contracts/settings'

const filenames: Record<InstructionKind, string> = {
  agents: 'AGENTS.md',
  'append-system': 'APPEND_SYSTEM.md',
  system: 'SYSTEM.md',
}

function within(root: string, target: string) {
  const relative = path.relative(root, target)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

async function readInstruction(root: string, filename: string): Promise<InstructionFile> {
  const resolvedRoot = await realpath(root)
  let target = filename
  let content = ''
  let exists = false
  try {
    target = await realpath(filename)
    if (!within(resolvedRoot, target)) throw new Error(`指令文件超出允许目录：${filename}`)
    if (!(await lstat(target)).isFile()) throw new Error(`指令路径必须是文件：${filename}`)
    content = await readFile(target, 'utf8')
    exists = true
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    // 文件尚不存在时也检查最近的父目录，避免通过目录软链接写到外部。
    let parent = path.dirname(filename)
    for (;;) {
      try {
        const resolvedParent = await realpath(parent)
        if (!within(resolvedRoot, resolvedParent)) throw new Error(`指令目录超出允许目录：${filename}`)
        target = path.join(resolvedParent, path.relative(parent, filename))
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        const next = path.dirname(parent)
        if (next === parent) throw error
        parent = next
      }
    }
  }
  return {
    path: target,
    exists,
    content,
    revision: createHash('sha256')
      .update(JSON.stringify([target, exists, content]))
      .digest('hex'),
  }
}

export function parseSaveInstruction(value: unknown): SaveInstruction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('指令保存参数无效')
  const input = value as SaveInstruction
  if (
    typeof input.kind !== 'string' ||
    !Object.hasOwn(filenames, input.kind) ||
    (input.content !== null && typeof input.content !== 'string') ||
    typeof input.revision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.revision) ||
    Object.keys(input).some((key) => !['kind', 'content', 'revision'].includes(key))
  )
    throw new Error('指令保存参数必须包含有效的类型、正文和文件版本')
  return input
}

export class InstructionsStore {
  private readonly root: string
  private readonly agentDir: string

  constructor(dataRoot: string) {
    if (!dataRoot || typeof dataRoot !== 'string') {
      throw new Error('InstructionsStore 必须提供有效的数据目录 (dataRoot)')
    }
    this.root = path.resolve(dataRoot)
    this.agentDir = path.join(this.root, storageLayoutRelativePaths.agentDirectory)
  }

  private async hostFile(kind: InstructionKind) {
    const resolvedRoot = await realpath(this.root)
    const configDir = path.join(this.root, 'config')
    const configStat = await lstat(configDir).catch(() => undefined)
    if (configStat?.isSymbolicLink()) {
      throw new Error('应用配置目录不能是符号链接')
    }
    const agentStat = await lstat(this.agentDir).catch(() => undefined)
    if (agentStat?.isSymbolicLink()) {
      throw new Error('用户指令目录不能指向数据目录之外')
    }
    const agentRoot = await realpath(this.agentDir).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code !== 'ENOENT') throw cause
      return this.agentDir
    })
    if (!within(resolvedRoot, agentRoot)) throw new Error('用户指令目录不能指向数据目录之外')
    const selected = kind === 'agents' ? readDesktopAgentContextFile(this.agentDir) : undefined
    const file = await readInstruction(this.root, selected?.path ?? path.join(this.agentDir, filenames[kind]))
    if (!within(agentRoot, file.path)) throw new Error(`指令文件超出用户指令目录：${file.path}`)
    return file
  }

  async snapshot(cwd: string): Promise<InstructionsSnapshot> {
    const entries = await Promise.all(
      (Object.keys(filenames) as InstructionKind[]).map(async (kind) => {
        const host = await this.hostFile(kind)
        const selected = kind === 'agents' ? readDesktopAgentContextFile(cwd) : undefined
        const projectFile = await readInstruction(
          cwd,
          selected?.path ?? path.join(cwd, kind === 'agents' ? '' : '.pi', filenames[kind]),
        )
        const project = projectFile.exists ? projectFile : null
        const effective = project
          ? kind === 'agents' && host.exists
            ? 'combined'
            : 'project'
          : host.exists
            ? 'host'
            : 'default'
        return { kind, host, project, effective } as const
      }),
    )
    return { entries, cwd }
  }

  async save(input: SaveInstruction) {
    const current = await this.hostFile(input.kind)
    if (current.revision !== input.revision)
      throw new Error('指令文件已被其他操作修改，请重新读取后再保存；当前草稿仍保留')
    if (input.content === null) {
      if (current.exists) await rm(current.path)
      return
    }
    await mkdir(path.dirname(current.path), { recursive: true, mode: 0o700 })
    const temporary = path.join(path.dirname(current.path), `.instruction-${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, input.content, { flag: 'wx', mode: 0o600 })
      if ((await this.hostFile(input.kind)).revision !== input.revision)
        throw new Error('指令文件已被其他操作修改，请重新读取后再保存；当前草稿仍保留')
      await rename(temporary, current.path)
    } finally {
      await rm(temporary, { force: true })
    }
  }
}
