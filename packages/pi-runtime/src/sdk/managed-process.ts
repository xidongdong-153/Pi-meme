import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import type { Writable } from 'node:stream'

export type ManagedProcessExit = { exitCode: number | null; signal: string | null }
export type ManagedProcess = {
  completion: Promise<ManagedProcessExit>
  stop: () => Promise<ManagedProcessExit>
  kill: () => void
}
export type ManagedProcessOptions = {
  cwd: string
  env: NodeJS.ProcessEnv
  onData: (chunk: Buffer) => void
  seccomp?: Buffer
}

/** 托管同一进程组；不接管自行脱离进程组的 daemon。 */
export async function spawnManagedProcess(
  executable: string,
  args: string[],
  options: ManagedProcessOptions,
): Promise<ManagedProcess> {
  if (process.platform !== 'darwin' && process.platform !== 'linux')
    throw new Error(`当前平台不支持受管服务：${process.platform}`)
  const child = spawn(executable, args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: options.seccomp ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
  })
  let finished = false
  let stopRequested = false
  const signalGroup = (signal: NodeJS.Signals) => {
    if (finished || !child.pid) return
    try {
      process.kill(-child.pid, signal)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') throw cause
    }
  }
  const alive = () => {
    if (finished || !child.pid) return false
    try {
      process.kill(-child.pid, 0)
      return true
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ESRCH') return false
      // macOS 在进程组退出的短暂窗口也可能返回 EPERM；继续核对，不宣称已退出。
      if ((cause as NodeJS.ErrnoException).code === 'EPERM') return true
      throw cause
    }
  }
  const waitGroup = async (milliseconds: number) => {
    const deadline = Date.now() + milliseconds
    while (alive() && Date.now() < deadline) await delay(25)
    return !alive()
  }
  const kill = () => signalGroup('SIGKILL')
  const shutdown = () => {
    try {
      kill()
    } catch {
      // 退出钩子无法等待；正常释放由 stop 确认结果。
    }
  }
  process.once('exit', shutdown)
  child.stdout!.on('data', options.onData)
  child.stderr!.on('data', options.onData)
  child.stdin!.on('error', () => {})
  child.stdin!.end()
  if (options.seccomp) {
    const filter = child.stdio[3] as Writable
    filter.on('error', () => {})
    filter.end(options.seccomp)
  }
  let exitCleanupError: unknown
  child.once('exit', () => {
    if (stopRequested) return
    try {
      // 主进程自然结束时不能把仍存活的同组子进程留给用户。
      kill()
    } catch (cause) {
      exitCleanupError = cause
    }
  })
  const closed = new Promise<ManagedProcessExit>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }))
  })
  const completion = closed.then(async (result) => {
    if (!(await waitGroup(stopRequested ? 4500 : 1500)))
      throw exitCleanupError ?? new Error('服务主进程已退出，但进程组仍未完成清理')
    finished = true
    process.removeListener('exit', shutdown)
    return result
  })
  void completion.catch(() => {
    try {
      if (!alive()) {
        finished = true
        process.removeListener('exit', shutdown)
      }
    } catch {
      // 核对失败时保留退出钩子，显式 stop 可以再次尝试清理。
    }
  })
  // 启动返回到业务层前，进程也可能立即退出。
  void completion.catch(() => {})
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  let stopping: Promise<ManagedProcessExit> | undefined
  return {
    completion,
    kill,
    stop: () => {
      stopping ??= (async () => {
        stopRequested = true
        try {
          signalGroup('SIGTERM')
        } catch (cause) {
          if (!(await waitGroup(1500))) throw cause
        }
        if (!(await waitGroup(3000))) {
          kill()
          if (!(await waitGroup(1500))) throw new Error('发送强制终止后服务进程组仍存在，请检查服务进程权限')
        }
        const result = await closed
        finished = true
        process.removeListener('exit', shutdown)
        return result
      })().catch((cause: unknown) => {
        stopRequested = false
        stopping = undefined
        throw cause
      })
      return stopping
    },
  }
}

export function serviceProcessEnvironment(env?: NodeJS.ProcessEnv) {
  const result = { ...process.env, ...env }
  delete result.NODE_OPTIONS
  delete result.NODE_PATH
  delete result.BASH_ENV
  delete result.ENV
  return result
}
