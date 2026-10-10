import { spawn } from 'node:child_process'
import { access, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { AgentAccessMode } from '@pi-meme/contracts/agent-access'

export type AccessSandboxOptions = {
  mode: Exclude<AgentAccessMode, 'full-access'>
  cwd: string
  /** 会话临时目录，工作区写入白名单之一。 */
  temporary: string
  agentDir: string
}

type RunOptions = {
  cwd: string
  input?: string
  env?: NodeJS.ProcessEnv
  timeout?: number
  signal?: AbortSignal
  onData: (chunk: Buffer) => void
}

/** 根目录先解析符号链接，Seatbelt 按实际文件路径判定。 */
async function accessProfile(mode: AccessSandboxOptions['mode'], cwd: string, temporary: string, agentDir: string) {
  const roots = [await realpath(temporary)]
  if (mode === 'workspace-write') {
    const project = await realpath(cwd)
    let agentRoot: string | undefined
    try {
      agentRoot = await realpath(agentDir)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    }
    if (
      project === path.parse(project).root ||
      project === (await realpath(homedir())) ||
      project === path.dirname(roots[0]) ||
      project === agentRoot
    )
      throw new Error('请先选择具体项目目录，不能将用户目录、Pi 配置目录或系统临时目录整体授权为工作区')
    roots.push(project)
  }
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    '(allow file-write* (literal "/dev/null"))',
    `(allow file-write* ${roots.map((root) => `(subpath ${JSON.stringify(root)})`).join(' ')})`,
  ].join('\n')
}

/**
 * 受限权限会话的沙箱。
 *
 * 工具子进程统一经 `sandbox-exec` 启动；写文件也走沙箱内的系统命令
 * （`/bin/mkdir`、`/usr/bin/tee`），不再需要 Node 辅助进程。
 */
export class AccessSandbox {
  private readonly running = new Set<() => void>()

  private constructor(
    private readonly mode: AccessSandboxOptions['mode'],
    private readonly cwd: string,
    private readonly temporary: string,
    private readonly profile: string,
  ) {}

  /** 构造沙箱并在其中执行一次 `/usr/bin/true`；失败直接拒绝创建受限会话。 */
  static async create(options: AccessSandboxOptions) {
    if (process.platform !== 'darwin') throw new Error('受限权限目前仅支持 macOS')
    await access('/usr/bin/sandbox-exec')
    const temporary = await realpath(options.temporary)
    const profile = await accessProfile(options.mode, options.cwd, temporary, options.agentDir)
    const sandbox = new AccessSandbox(options.mode, await realpath(options.cwd), temporary, profile)
    const result = await sandbox.run('/usr/bin/true', [], { cwd: sandbox.cwd, onData: () => {}, timeout: 5 })
    if (result.exitCode !== 0) throw new Error('macOS 沙箱检查失败')
    return sandbox
  }

  /** 只读展示用的工作区路径。 */
  get workspace() {
    return this.cwd
  }

  /** 在沙箱里运行进程；取消、超时和进程退出都会终止整个进程组。 */
  run(executable: string, args: string[], options: RunOptions): Promise<{ exitCode: number }> {
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) return reject(new Error('aborted'))
      const env = { ...process.env, ...options.env }
      delete env.NODE_OPTIONS
      delete env.NODE_PATH
      delete env.BASH_ENV
      delete env.ENV
      const child = spawn('/usr/bin/sandbox-exec', ['-p', this.profile, executable, ...args], {
        cwd: options.cwd,
        env,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let timedOut = false
      const kill = () => {
        if (!child.pid) return
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL')
        }
      }
      const abort = () => kill()
      const shutdown = () => kill()
      this.running.add(kill)
      const timer = options.timeout
        ? setTimeout(() => {
            timedOut = true
            kill()
          }, options.timeout * 1000)
        : undefined
      options.signal?.addEventListener('abort', abort, { once: true })
      process.once('exit', shutdown)
      child.stdout.on('data', options.onData)
      child.stderr.on('data', options.onData)
      child.stdin.on('error', () => {
        // 启动失败或取消会关闭 stdin；错误由 error / close 统一返回。
      })
      child.stdin.end(options.input)
      const cleanup = () => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', abort)
        process.removeListener('exit', shutdown)
        this.running.delete(kill)
        kill()
      }
      child.once('error', (cause) => {
        cleanup()
        reject(cause)
      })
      child.once('exit', kill)
      child.once('close', (exitCode) => {
        cleanup()
        if (options.signal?.aborted) reject(new Error('aborted'))
        else if (timedOut) reject(new Error(`timeout:${options.timeout}`))
        else resolve({ exitCode: exitCode ?? 0 })
      })
    })
  }

  stopAll() {
    for (const kill of this.running) kill()
  }

  /** 写入白名单：会话工作区与临时目录；只读模式全部拒绝。 */
  async assertWritable(target: string) {
    if (this.mode === 'read-only') throw new Error(`当前权限禁止修改本地文件：${target}`)
    let current = path.resolve(target)
    const tail: string[] = []
    for (;;) {
      try {
        current = path.join(await realpath(current), ...tail)
        break
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(current) === current) throw cause
        tail.unshift(path.basename(current))
        current = path.dirname(current)
      }
    }
    const inside = (root: string) => {
      const relative = path.relative(root, current)
      return (
        relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
      )
    }
    if (!inside(this.cwd) && !inside(this.temporary)) throw new Error(`当前权限不允许写入项目外路径：${target}`)
  }

  async mkdir(target: string, signal?: AbortSignal) {
    await this.assertWritable(target)
    await this.fileCommand('/bin/mkdir', ['-p', target], target, undefined, signal)
  }

  async writeFile(target: string, content: string, signal?: AbortSignal) {
    await this.assertWritable(target)
    await this.fileCommand('/usr/bin/tee', [target], target, content, signal)
  }

  private async fileCommand(
    executable: string,
    args: string[],
    target: string,
    content: string | undefined,
    signal?: AbortSignal,
  ) {
    let error = ''
    const result = await this.run(executable, args, {
      cwd: this.cwd,
      input: content,
      onData: (chunk) => {
        error = (error + chunk.toString()).slice(-4096)
      },
      timeout: 30,
      signal,
    })
    if (result.exitCode !== 0) throw new Error(error || `当前权限不允许写入路径：${target}`)
  }
}
