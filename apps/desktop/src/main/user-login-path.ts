import { spawn } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const pathStart = '\0PI_MEME_PATH\0'
const pathEnd = '\0PI_MEME_PATH_END\0'
const probeCommand = String.raw`printf '\000PI_MEME_PATH\000%s\000PI_MEME_PATH_END\000' "$PATH"`
let cachedLoginPath: Promise<string | undefined> | undefined

function executable(value: string | undefined): value is string {
  if (!value || !path.isAbsolute(value)) return false
  try {
    accessSync(value, constants.X_OK)
    return statSync(value).isFile()
  } catch {
    return false
  }
}

function directory(value: string): boolean {
  if (!path.isAbsolute(value)) return false
  try {
    return statSync(value).isDirectory()
  } catch {
    return false
  }
}

function failedProbe(reason: string) {
  console.warn(`无法恢复登录 Shell PATH：${reason}；继续使用继承 PATH 和已存在的常用工具目录。`)
  return undefined
}

function probeLoginPath(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const shell = [env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'].find(executable)
  if (!shell) return Promise.resolve(failedProbe('未找到可执行的 Shell'))
  return new Promise((resolve) => {
    const child = spawn(shell, ['-lic', probeCommand], {
      env,
      cwd: env.HOME || homedir(),
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let settled = false
    let output = ''
    let bytes = 0
    let timer: NodeJS.Timeout
    const kill = () => {
      if (!child.pid) return
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL')
      }
    }
    const finish = (value: string | undefined, reason?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      kill()
      resolve(reason ? failedProbe(reason) : value)
    }
    timer = setTimeout(finish, 5000, undefined, '探测超过 5 秒')
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > 64 * 1024) finish(undefined, '探测输出超过 64 KiB')
      else output += chunk
    })
    child.once('error', () => finish(undefined, '无法启动探测进程'))
    // Shell 退出时一并回收仍持有输出管道的后代，避免等待 close 挂起。
    child.once('exit', kill)
    child.once('close', (code) => {
      if (settled) return
      if (code !== 0) return finish(undefined, `探测进程未正常退出（${code}）`)
      const start = output.indexOf(pathStart)
      const end = output.indexOf(pathEnd, start + pathStart.length)
      const value = start === -1 || end === -1 ? '' : output.slice(start + pathStart.length, end)
      finish(value || undefined, value ? undefined : 'Shell 未返回有效 PATH')
    })
  })
}

/** 只为新建的 macOS Desktop Host 补齐 PATH，不导入 Shell 导出的其他变量。 */
export async function prepareDesktopHostEnv(env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  if (process.platform !== 'darwin') return { ...env }
  cachedLoginPath ??= probeLoginPath(env).catch(() => failedProbe('探测进程发生错误'))
  const loginPath = await cachedLoginPath
  const home = env.HOME || homedir()
  const userBins = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    path.join(home, '.local/bin'),
    path.join(home, '.cargo/bin'),
    path.join(home, 'Library/pnpm'),
    ...(env.PNPM_HOME ? [env.PNPM_HOME] : []),
  ].filter(directory)
  const entries = [loginPath, env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin', ...userBins]
    .flatMap((value) => value?.split(path.delimiter) ?? [])
    .filter(Boolean)
  return { ...env, PATH: [...new Set(entries)].join(path.delimiter) }
}
