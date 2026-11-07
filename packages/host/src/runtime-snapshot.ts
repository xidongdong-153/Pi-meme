import { createHash } from 'node:crypto'
import * as nodeFs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { promisify } from 'node:util'

// Electron's patched fs exposes ASAR archives as virtual directories. Snapshot identity is physical bytes.
const physicalFs = process.versions.electron
  ? (createRequire(process.execPath)('original-fs') as typeof nodeFs)
  : nodeFs
const chmod = promisify(physicalFs.chmod)
const lstat = promisify(physicalFs.lstat)
const mkdir = promisify(physicalFs.mkdir)
const mkdtemp = promisify(physicalFs.mkdtemp)
const readFile = promisify(physicalFs.readFile)
const readdir = promisify(physicalFs.readdir)
const readlink = promisify(physicalFs.readlink)
const realpath = promisify(physicalFs.realpath)
const rename = promisify(physicalFs.rename)
const rm = promisify(physicalFs.rm)
const writeFile = promisify(physicalFs.writeFile)

const manifestName = '.runtime-snapshot.json'
const format = 1

type SnapshotEntry =
  { path: string; type: 'file'; digest: string; executable: boolean } | { path: string; type: 'link'; target: string }

export function runtimeSnapshotPaths(root: string) {
  root = path.resolve(root)
  return {
    root,
    workerPath: path.join(root, 'server/session-worker.js'),
    hostPath: path.join(root, 'desktop/host-process.js'),
    serverPath: path.join(root, 'server/main.js'),
    desktopPath: path.join(root, 'desktop/main.js'),
    staticDirectory: path.join(root, 'frontend'),
    skillsDirectory: path.join(root, 'skills'),
    nodePath: path.join(root, 'runtime/bin', process.platform === 'win32' ? 'node.exe' : 'node'),
    restrictedEntry: path.join(root, 'runtime/restricted-entry.mjs'),
    windowsNativePath: path.join(root, 'runtime/bin/pi-meme-windows.exe'),
    dockDirectory: path.join(root, 'assets/dock'),
    electronPath: path.join(
      root,
      'electron',
      process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron.exe',
    ),
  }
}

export type RuntimeSnapshotPaths = ReturnType<typeof runtimeSnapshotPaths>

function inside(root: string, target: string) {
  const relative = path.relative(root, target)
  return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

async function entries(root: string): Promise<SnapshotEntry[]> {
  const result: SnapshotEntry[] = []
  async function visit(directory: string) {
    for (const name of (await readdir(directory)).sort()) {
      if (directory === root && name === manifestName) continue
      const file = path.join(directory, name)
      const relative = path.relative(root, file).split(path.sep).join('/')
      const stat = await lstat(file)
      if (stat.isSymbolicLink()) {
        const target = await readlink(file)
        if (path.isAbsolute(target) || !inside(root, await realpath(file)))
          throw new Error(`runtime-snapshot-invalid: 快照链接越界：${relative}`)
        result.push({ path: relative, type: 'link', target })
      } else if (stat.isDirectory()) await visit(file)
      else if (stat.isFile()) {
        if (stat.nlink !== 1) throw new Error(`runtime-snapshot-invalid: 快照文件不能共享硬链接：${relative}`)
        result.push({
          path: relative,
          type: 'file',
          digest: createHash('sha256')
            .update(await readFile(file))
            .digest('hex'),
          executable: Boolean(stat.mode & 0o111),
        })
      } else throw new Error(`runtime-snapshot-invalid: 快照包含特殊文件：${relative}`)
    }
  }
  await visit(root)
  return result.sort((a, b) => a.path.localeCompare(b.path, 'en'))
}

function digest(value: SnapshotEntry[]) {
  return createHash('sha256')
    .update(JSON.stringify({ format, entries: value }))
    .digest('hex')
}

/** Validate before loading owner code; dependencies and UI must be in this same immutable tree. */
export async function readRuntimeSnapshot(root: string, dataRoot?: string): Promise<RuntimeSnapshotPaths> {
  const resolved = await realpath(root)
  if (dataRoot) {
    const parent = path.join(await realpath(dataRoot), 'runtime-snapshots')
    if (path.dirname(resolved) !== parent) throw new Error('runtime-snapshot-invalid: 快照不属于当前 Host 数据目录')
  }
  const manifest = JSON.parse(await readFile(path.join(resolved, manifestName), 'utf8')) as {
    format?: number
    digest?: string
    entries?: unknown
  }
  const actual = await entries(resolved)
  const hash = digest(actual)
  if (
    manifest.format !== format ||
    manifest.digest !== hash ||
    path.basename(resolved) !== hash ||
    JSON.stringify(manifest.entries) !== JSON.stringify(actual)
  )
    throw new Error('runtime-snapshot-invalid: 固定运行时快照校验失败；请显式重启开发入口重新构建')
  const paths = runtimeSnapshotPaths(resolved)
  for (const file of [
    paths.workerPath,
    paths.serverPath,
    path.join(paths.staticDirectory, 'index.html'),
    paths.nodePath,
  ]) {
    if (!(await lstat(file)).isFile()) throw new Error('runtime-snapshot-invalid: 快照缺少固定入口')
  }
  return paths
}

async function freeze(directory: string) {
  for (const name of await readdir(directory)) {
    const file = path.join(directory, name)
    const stat = await lstat(file)
    if (stat.isDirectory()) await freeze(file)
    else if (stat.isFile()) await chmod(file, stat.mode & 0o111 ? 0o555 : 0o444)
  }
  await chmod(directory, 0o555)
}

/** Called only by an explicit startup. No watcher, symlink to the repository or in-place update is allowed. */
export async function createRuntimeSnapshot(options: {
  dataRoot: string
  prepare: (directory: string) => Promise<void>
}): Promise<RuntimeSnapshotPaths> {
  await mkdir(options.dataRoot, { recursive: true, mode: 0o700 })
  const dataRoot = await realpath(options.dataRoot)
  const parent = path.join(dataRoot, 'runtime-snapshots')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  if ((await realpath(parent)) !== parent) throw new Error('runtime-snapshot-invalid: 快照父目录不能是链接')
  const pending = await mkdtemp(path.join(parent, '.prepare-'))
  let published = false
  try {
    await options.prepare(pending)
    const files = await entries(pending)
    const hash = digest(files)
    await writeFile(path.join(pending, manifestName), JSON.stringify({ format, digest: hash, entries: files }), {
      mode: 0o600,
      flag: 'wx',
    })
    const target = path.join(parent, hash)
    try {
      await rename(pending, target)
      published = true
    } catch (cause) {
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes((cause as NodeJS.ErrnoException).code ?? '')) throw cause
      // Concurrent explicit startups may have published the identical content.
      return await readRuntimeSnapshot(target, dataRoot)
    }
    await freeze(target)
    return await readRuntimeSnapshot(target, dataRoot)
  } finally {
    if (!published) await rm(pending, { recursive: true, force: true })
  }
}
