import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const stagedExecutables = new Set<string>()

async function stageNativeExecutable(source: string) {
  source = await realpath(source)
  if (stagedExecutables.has(source)) return source
  const contents = await readFile(source)
  const digest = createHash('sha256').update(contents).digest('hex')
  const cache = path.join(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData/Local'), 'Pi meme/windows-native')
  const directory = path.join(cache, digest)
  const target = path.join(directory, 'pi-meme-windows.exe')
  const verify = async () => {
    if (!(await readFile(target)).equals(contents))
      throw new Error(`Windows 原生程序缓存校验失败，请退出应用并删除此目录后重试：${directory}`)
  }
  try {
    await verify()
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    await mkdir(cache, { recursive: true })
    const pending = await mkdtemp(path.join(cache, '.prepare-'))
    try {
      await writeFile(path.join(pending, 'pi-meme-windows.exe'), contents)
      try {
        await rename(pending, directory)
      } catch {
        // 其他 Host 或 Worker 可能已经准备好相同版本。
        await verify()
      }
    } finally {
      await rm(pending, { recursive: true, force: true })
    }
  }
  const executable = await realpath(target)
  stagedExecutables.add(executable)
  // 后续 Worker 继承固定副本，不再从可写项目加载原生程序。
  process.env.PI_MEME_WINDOWS_NATIVE = executable
  return executable
}

export async function windowsNodeExecutable() {
  const node = process.env.PI_MEME_PLUGIN_NODE || (process.versions.electron ? '' : process.execPath)
  if (!node || !path.isAbsolute(node)) throw new Error('Windows 受限执行缺少固定 Node 运行时')
  return realpath(node)
}

export async function windowsNativeExecutable() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows 原生程序仅支持 Windows x64')
  const directory = typeof __dirname === 'string' ? __dirname : path.dirname(fileURLToPath(import.meta.url))
  const configured = process.env.PI_MEME_WINDOWS_NATIVE
  const candidates = configured ? [configured] : []
  if (!configured) {
    let root = directory
    for (let depth = 0; depth < 8; depth++) {
      candidates.push(path.join(root, 'packages/windows-native/native/target/release/pi-meme-windows.exe'))
      root = path.dirname(root)
    }
  }
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) throw new Error('Windows 原生程序路径必须是绝对路径')
    try {
      await access(candidate)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
      continue
    }
    return stageNativeExecutable(candidate)
  }
  throw new Error('Windows 原生程序未准备，请运行 pnpm --filter @pi-meme/windows-native build:native 后重试')
}

export async function queryWindowsNative(operation: 'fonts' | 'editor-roots' | 'sandbox-probe'): Promise<unknown> {
  try {
    const { stdout } = await execute(await windowsNativeExecutable(), [operation], {
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
    })
    return JSON.parse(stdout)
  } catch (cause) {
    const output = (cause as { stdout?: string }).stdout
    if (output) {
      let diagnostic: { type?: string; message?: string } | undefined
      try {
        diagnostic = JSON.parse(output)
      } catch {
        /* 保留非 JSON 启动错误。 */
      }
      if (diagnostic?.type === 'error' && diagnostic.message) throw new Error(diagnostic.message)
    }
    throw cause
  }
}
