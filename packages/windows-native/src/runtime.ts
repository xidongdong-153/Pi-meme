import { access, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)

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
      return candidate
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    }
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
