import { spawn } from 'node:child_process'
import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { linuxSandboxLaunch } from './linux-sandbox'
import { serviceProcessEnvironment, spawnManagedProcess, type ManagedProcess } from './managed-process'
import type { AgentAccessMode } from '@pi-meme/contracts/agent-access'
import { storageLayoutRelativePaths } from '@pi-meme/contracts/storage-paths'
import { spawnWindowsProcess, type WindowsSandboxPolicy } from '@pi-meme/windows-native/process'
import { windowsSandboxEnvironment, windowsRuntimeReadPaths } from '@pi-meme/windows-native/sandbox'
import { windowsSandboxPolicy } from './windows-sandbox'
import { windowsNodeExecutable } from '@pi-meme/windows-native/runtime'

export type AccessSandboxOptions = {
  mode: Exclude<AgentAccessMode, 'full-access'>
  cwd: string
  /** 会话临时目录，工作区写入白名单之一。 */
  temporary: string
  agentDir: string
  dataRoot?: string
}

export type SandboxRunOptions = {
  cwd: string
  input?: string
  env?: NodeJS.ProcessEnv
  timeout?: number
  signal?: AbortSignal
  onData: (chunk: Buffer) => void
}

export type SandboxCapability = { supported: boolean; reason?: string }

export interface AccessSandboxOperations {
  readonly workspace: string
  startStdio?: (
    executable: string,
    args: string[],
    options: { cwd: string; env?: NodeJS.ProcessEnv },
  ) => Promise<{
    stdin: Writable
    stdout: Readable
    stderr: Readable
    completion: Promise<void>
    stop: () => Promise<void>
  }>
  run: (executable: string, args: string[], options: SandboxRunOptions) => Promise<{ exitCode: number }>
  startManaged: (
    executable: string,
    args: string[],
    options: Pick<SandboxRunOptions, 'cwd' | 'env' | 'onData'>,
  ) => Promise<ManagedProcess>
  stopAll: () => Promise<void>
  assertWritable: (target: string) => Promise<void>
  mkdir: (target: string, signal?: AbortSignal) => Promise<void>
  writeFile: (target: string, content: string, signal?: AbortSignal) => Promise<void>
}

export type SandboxLaunch = {
  executable: string
  args: string[]
  seccomp?: Buffer
  hiddenRoots?: string[]
  windows?: WindowsSandboxPolicy
}

export function pathWithin(root: string, value: string) {
  const relative = path.relative(root, value)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

/** 写入根目录先解析符号链接。 */
async function accessProfile(
  mode: AccessSandboxOptions['mode'],
  cwd: string,
  temporary: string,
  agentDir: string,
  dataRoot?: string,
) {
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
      project === (await realpath(tmpdir())) ||
      project === '/tmp' ||
      project === '/var/tmp' ||
      project === agentRoot ||
      (agentRoot !== undefined && pathWithin(agentRoot, project))
    )
      throw new Error('请先选择具体项目目录，不能将用户目录、Pi 配置目录或系统临时目录整体授权为工作区')
    roots.push(project)
  }
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    '(allow file-write* (literal "/dev/null"))',
    `(allow file-write* ${roots.map((root) => (dataRoot && pathWithin(root, dataRoot) ? `(require-all (subpath ${JSON.stringify(root)}) (require-not (subpath ${JSON.stringify(dataRoot)})))` : `(subpath ${JSON.stringify(root)})`)).join(' ')})`,
  ].join('\n')
}

/** 通用路径校验、文件工具与子进程清理；平台后端只生成启动参数。 */
class SandboxProcess implements AccessSandboxOperations {
  private readonly running = new Set<() => void>()
  private readonly executions = new Set<Promise<unknown>>()
  private readonly managed = new Set<Promise<unknown>>()
  private stopGeneration = 0

  constructor(
    private readonly mode: AccessSandboxOptions['mode'],
    private readonly cwd: string,
    private readonly temporary: string,
    private readonly launch: SandboxLaunch,
    private readonly protectedRoot?: string,
  ) {}

  /** 只读展示用的工作区路径。 */
  get workspace() {
    return this.cwd
  }

  private environment(env?: NodeJS.ProcessEnv) {
    const result = serviceProcessEnvironment(env)
    if (this.mode === 'read-only') {
      result.TMPDIR = this.temporary
      result.GIT_OPTIONAL_LOCKS = '0'
      result.GIT_PAGER = 'cat'
      result.PAGER = 'cat'
    }
    if (this.launch.seccomp) {
      delete result.WSL_INTEROP
      delete result.WSLENV
      delete result.LD_PRELOAD
      delete result.LD_LIBRARY_PATH
      result.PATH = (result.PATH ?? '/usr/bin:/bin')
        .split(path.delimiter)
        .filter((entry) => path.isAbsolute(entry) && !this.launch.hiddenRoots?.some((root) => pathWithin(root, entry)))
        .join(path.delimiter)
      result.TMPDIR = this.temporary
    }
    return result
  }

  private async startWindows(executable: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }) {
    const generation = this.stopGeneration
    const starting = (async () => {
      const child = await spawnWindowsProcess(executable, args, {
        cwd: await realpath(options.cwd),
        env: windowsSandboxEnvironment(this.temporary, options.env),
        sandbox: {
          ...this.launch.windows!,
          read: [...this.launch.windows!.read, ...(await windowsRuntimeReadPaths(executable))],
        },
      })
      if (generation !== this.stopGeneration) {
        await child.stop()
        throw new Error('受限进程启动已取消')
      }
      this.running.add(child.kill)
      this.executions.add(child.completion)
      void child.completion
        .finally(() => {
          this.running.delete(child.kill)
          this.executions.delete(child.completion)
        })
        .catch(() => {})
      return child
    })()
    this.executions.add(starting)
    try {
      return await starting
    } finally {
      this.executions.delete(starting)
    }
  }

  async startStdio(executable: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }) {
    if (this.launch.windows) {
      const child = await this.startWindows(executable, args, options)
      return {
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        completion: child.completion.then(() => {}),
        stop: async () => {
          await child.stop()
        },
      }
    }
    const cwd = await realpath(options.cwd)
    const launchArgs = [...this.launch.args]
    if (this.launch.seccomp) launchArgs[launchArgs.indexOf('--chdir') + 1] = cwd
    const child = spawn(this.launch.executable, [...launchArgs, executable, ...args], {
      cwd,
      env: this.environment(options.env),
      detached: true,
      stdio: this.launch.seccomp ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
    })
    const kill = () => {
      if (!child.pid) return
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL')
      }
    }
    this.running.add(kill)
    process.once('exit', kill)
    child.stdin!.on('error', () => {})
    if (this.launch.seccomp) {
      const filter = child.stdio[3] as Writable
      filter.on('error', () => {})
      filter.end(this.launch.seccomp)
    }
    const completion = new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', () => {
        kill()
        resolve()
      })
    }).finally(() => {
      this.running.delete(kill)
      process.off('exit', kill)
    })
    this.executions.add(completion)
    void completion.finally(() => this.executions.delete(completion)).catch(() => {})
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    return {
      stdin: child.stdin!,
      stdout: child.stdout!,
      stderr: child.stderr!,
      completion,
      stop: async () => {
        kill()
        await completion
      },
    }
  }

  async startManaged(executable: string, args: string[], options: Pick<SandboxRunOptions, 'cwd' | 'env' | 'onData'>) {
    if (this.launch.windows) {
      const child = await this.startWindows(executable, args, options)
      child.stdin.on('error', () => {})
      child.stdin.end()
      child.stdout.on('data', options.onData)
      child.stderr.on('data', options.onData)
      return child
    }
    const cwd = await realpath(options.cwd)
    const launchArgs = [...this.launch.args]
    if (this.launch.seccomp) launchArgs[launchArgs.indexOf('--chdir') + 1] = cwd
    const child = await spawnManagedProcess(this.launch.executable, [...launchArgs, executable, ...args], {
      cwd,
      env: this.environment(options.env),
      onData: options.onData,
      seccomp: this.launch.seccomp,
    })
    this.running.add(child.kill)
    void child.completion.finally(() => this.running.delete(child.kill)).catch(() => {})
    this.managed.add(child.completion)
    void child.completion.finally(() => this.managed.delete(child.completion)).catch(() => {})
    return child
  }

  /** 在沙箱里运行进程；取消、超时和进程退出都会终止整个进程组。 */
  async run(executable: string, args: string[], options: SandboxRunOptions): Promise<{ exitCode: number }> {
    if (this.launch.windows) {
      if (options.signal?.aborted) throw new Error('aborted')
      const child = await this.startWindows(executable, args, options)
      let timedOut = false
      const kill = child.kill
      const timer = options.timeout
        ? setTimeout(() => {
            timedOut = true
            kill()
          }, options.timeout * 1000)
        : undefined
      options.signal?.addEventListener('abort', kill, { once: true })
      if (options.signal?.aborted) kill()
      child.stdout.on('data', options.onData)
      child.stderr.on('data', options.onData)
      child.stdin.on('error', () => {})
      child.stdin.end(options.input)
      try {
        const result = await child.completion
        if (options.signal?.aborted) throw new Error('aborted')
        if (timedOut) throw new Error(`timeout:${options.timeout}`)
        return { exitCode: result.exitCode ?? 1 }
      } finally {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', kill)
      }
    }
    const cwd = await realpath(options.cwd)
    const execution = new Promise<{ exitCode: number }>((resolve, reject) => {
      if (options.signal?.aborted) return reject(new Error('aborted'))
      const env = this.environment(options.env)
      const launchArgs = [...this.launch.args]
      if (this.launch.seccomp) launchArgs[launchArgs.indexOf('--chdir') + 1] = cwd
      const child = spawn(this.launch.executable, [...launchArgs, executable, ...args], {
        cwd,
        env,
        detached: true,
        stdio: this.launch.seccomp ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
      })
      if (this.launch.seccomp) {
        const filter = child.stdio[3] as import('node:stream').Writable
        filter.on('error', () => {})
        filter.end(this.launch.seccomp)
      }
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
      child.stdout!.on('data', options.onData)
      child.stderr!.on('data', options.onData)
      child.stdin!.on('error', () => {
        // 启动失败或取消会关闭 stdin；错误由 error / close 统一返回。
      })
      child.stdin!.end(options.input)
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
        else resolve({ exitCode: exitCode ?? 1 })
      })
    })
    this.executions.add(execution)
    void execution.finally(() => this.executions.delete(execution)).catch(() => {})
    return execution
  }

  async stopAll() {
    this.stopGeneration++
    for (const kill of this.running) kill()
    await Promise.allSettled([...this.executions, ...this.managed])
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
    if (
      this.protectedRoot &&
      pathWithin(this.protectedRoot, current) &&
      !pathWithin(path.join(this.protectedRoot, storageLayoutRelativePaths.standaloneWorkspacesDirectory), this.cwd)
    )
      throw new Error(`当前权限不允许写入应用数据路径：${target}`)
    if (!inside(this.cwd) && !inside(this.temporary)) throw new Error(`当前权限不允许写入项目外路径：${target}`)
  }

  async mkdir(target: string, signal?: AbortSignal) {
    await this.assertWritable(target)
    if (this.launch.windows)
      return this.fileCommand(
        this.launch.executable,
        ['-e', 'require("node:fs").mkdirSync(process.argv[1],{recursive:true})', target],
        target,
        undefined,
        signal,
      )
    await this.fileCommand('/bin/mkdir', ['-p', target], target, undefined, signal)
  }

  async writeFile(target: string, content: string, signal?: AbortSignal) {
    await this.assertWritable(target)
    if (this.launch.windows)
      return this.fileCommand(
        this.launch.executable,
        ['-e', 'require("node:fs").writeFileSync(process.argv[1],require("node:fs").readFileSync(0))', target],
        target,
        content,
        signal,
      )
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

export const AccessSandbox = {
  async create(options: AccessSandboxOptions): Promise<AccessSandboxOperations> {
    const cwd = await realpath(options.cwd)
    const temporary = await realpath(options.temporary)
    const protectedRoot = options.dataRoot ? await realpath(options.dataRoot) : undefined
    if (
      protectedRoot &&
      pathWithin(protectedRoot, cwd) &&
      !pathWithin(path.join(protectedRoot, storageLayoutRelativePaths.standaloneWorkspacesDirectory), cwd)
    )
      throw new Error('请先选择具体项目目录，不能将应用数据目录授权为工作区')
    if (protectedRoot && pathWithin(protectedRoot, temporary)) throw new Error('会话临时目录不能位于应用数据目录内')
    const profile = await accessProfile(options.mode, cwd, temporary, options.agentDir, protectedRoot)
    let launch: SandboxLaunch
    if (process.platform === 'darwin') {
      await access('/usr/bin/sandbox-exec')
      launch = { executable: '/usr/bin/sandbox-exec', args: ['-p', profile] }
    } else if (process.platform === 'linux') {
      launch = await linuxSandboxLaunch({ ...options, cwd, temporary })
    } else if (process.platform === 'win32') {
      launch = {
        executable: await windowsNodeExecutable(),
        args: [],
        windows: await windowsSandboxPolicy({ ...options, cwd, temporary }),
      }
    } else throw new Error(`当前平台不支持受限权限：${process.platform}`)
    const sandbox = new SandboxProcess(options.mode, cwd, temporary, launch, protectedRoot)
    let diagnostic = ''
    const result = await sandbox.run(
      process.platform === 'win32' ? launch.executable : '/usr/bin/true',
      process.platform === 'win32' ? ['-e', 'process.exit(0)'] : [],
      {
        cwd,
        onData: (chunk) => {
          diagnostic = (diagnostic + chunk.toString()).slice(-4096)
        },
        timeout: 5,
      },
    )
    if (result.exitCode !== 0)
      throw new Error(`沙箱启动检查失败（${result.exitCode}）：${diagnostic.trim() || '进程未返回诊断'}`)
    return sandbox
  },
}

/** 同时验证白名单写入、越界拒绝和 Linux socket 过滤，失败保留系统诊断。 */
export async function probeAccessSandbox(): Promise<SandboxCapability> {
  if (!['darwin', 'linux', 'win32'].includes(process.platform))
    return {
      supported: false,
      reason: `当前平台不支持受限权限：${process.platform}`,
    }
  let directory: string | undefined
  let sandbox: AccessSandboxOperations | undefined
  let outside: string | undefined
  try {
    directory = await realpath(await mkdtemp(path.join(tmpdir(), 'pi-sandbox-probe-')))
    const cwd = path.join(directory, 'project')
    const temporary = path.join(directory, 'temporary')
    outside = await realpath(await mkdtemp(path.join(homedir(), '.pi-sandbox-probe-')))
    await Promise.all([mkdir(cwd), mkdir(temporary)])
    await writeFile(path.join(outside, 'original'), 'original')
    sandbox = await AccessSandbox.create({
      mode: 'workspace-write',
      cwd,
      temporary,
      agentDir: path.join(directory, 'agent'),
    })
    await sandbox.writeFile(path.join(cwd, 'allowed'), 'allowed')
    if ((await readFile(path.join(cwd, 'allowed'), 'utf8')) !== 'allowed') throw new Error('工作区写入探测失败')
    let diagnostic = ''
    const run = (executable: string, args: string[]) =>
      sandbox!.run(executable, args, {
        cwd,
        timeout: 5,
        onData: (chunk) => {
          diagnostic = (diagnostic + chunk.toString()).slice(-4096)
        },
      })
    const denied = await run(
      process.platform === 'win32' ? await windowsNodeExecutable() : '/usr/bin/tee',
      process.platform === 'win32'
        ? ['-e', 'require("node:fs").writeFileSync(process.argv[1],"forbidden")', path.join(outside, 'original')]
        : [path.join(outside, 'original')],
    )
    if (denied.exitCode === 0 || (await readFile(path.join(outside, 'original'), 'utf8')) !== 'original')
      throw new Error('项目外写入未被隔离')
    if (process.platform === 'linux') {
      const socketProbe = await run(process.execPath, [
        '--input-type=module',
        '-e',
        `
        import assert from 'node:assert/strict'
        import net from 'node:net'
        import dgram from 'node:dgram'
        const denied = net.createConnection({ path: '/run/pi-sandbox-probe.sock' })
        await new Promise((resolve, reject) => {
          denied.once('connect', () => reject(new Error('AF_UNIX 未被隔离')))
          denied.once('error', (error) => {
            try { assert.equal(error.code, 'EPERM'); resolve() } catch (cause) { reject(cause) }
          })
        })
        const tcp = net.createServer()
        await new Promise((resolve, reject) => { tcp.once('error', reject); tcp.listen(0, '127.0.0.1', resolve) })
        await new Promise((resolve) => tcp.close(resolve))
        const udp = dgram.createSocket('udp4')
        await new Promise((resolve, reject) => { udp.once('error', reject); udp.bind(0, '127.0.0.1', resolve) })
        udp.close()
      `,
      ])
      if (socketProbe.exitCode !== 0) throw new Error(`socket 隔离探测失败：${diagnostic}`)
    }
    return { supported: true }
  } catch (cause) {
    const diagnostic = cause instanceof Error ? cause.message : String(cause)
    const guidance =
      process.platform === 'linux'
        ? '请检查 bubblewrap、seccomp 和系统 namespace 策略后重启服务'
        : process.platform === 'win32'
          ? '请检查 Windows 更新与原生 PSEC 沙箱后重启服务'
          : '请检查 sandbox-exec 和系统沙箱策略后重启服务'
    return {
      supported: false,
      reason: `受限权限不可用：${diagnostic}；${guidance}`,
    }
  } finally {
    await sandbox?.stopAll()
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {})
    if (outside) await rm(outside, { recursive: true, force: true }).catch(() => {})
  }
}
