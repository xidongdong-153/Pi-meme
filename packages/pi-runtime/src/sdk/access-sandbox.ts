import { spawn } from 'node:child_process'
import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { linuxSandboxLaunch } from './linux-sandbox'
import type { AgentAccessMode } from '@pi-meme/contracts/agent-access'

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
  run: (executable: string, args: string[], options: SandboxRunOptions) => Promise<{ exitCode: number }>
  stopAll: () => void
  assertWritable: (target: string) => Promise<void>
  mkdir: (target: string, signal?: AbortSignal) => Promise<void>
  writeFile: (target: string, content: string, signal?: AbortSignal) => Promise<void>
}

export type SandboxLaunch = { executable: string; args: string[]; seccomp?: Buffer; hiddenRoots?: string[] }

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

  /** 在沙箱里运行进程；取消、超时和进程退出都会终止整个进程组。 */
  async run(executable: string, args: string[], options: SandboxRunOptions): Promise<{ exitCode: number }> {
    const cwd = await realpath(options.cwd)
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) return reject(new Error('aborted'))
      const env = { ...process.env, ...options.env }
      delete env.NODE_OPTIONS
      delete env.NODE_PATH
      delete env.BASH_ENV
      delete env.ENV
      if (this.launch.seccomp) {
        delete env.WSL_INTEROP
        delete env.WSLENV
        delete env.LD_PRELOAD
        delete env.LD_LIBRARY_PATH
        env.PATH = (env.PATH ?? '/usr/bin:/bin')
          .split(path.delimiter)
          .filter(
            (entry) => path.isAbsolute(entry) && !this.launch.hiddenRoots?.some((root) => pathWithin(root, entry)),
          )
          .join(path.delimiter)
        env.TMPDIR = this.temporary
      }
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
    if (
      this.protectedRoot &&
      pathWithin(this.protectedRoot, current) &&
      !pathWithin(path.join(this.protectedRoot, 'standalone-workspaces'), this.cwd)
    )
      throw new Error(`当前权限不允许写入 Host 数据路径：${target}`)
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

export const AccessSandbox = {
  async create(options: AccessSandboxOptions): Promise<AccessSandboxOperations> {
    const cwd = await realpath(options.cwd)
    const temporary = await realpath(options.temporary)
    const protectedRoot = options.dataRoot ? await realpath(options.dataRoot) : undefined
    if (
      protectedRoot &&
      pathWithin(protectedRoot, cwd) &&
      !pathWithin(path.join(protectedRoot, 'standalone-workspaces'), cwd)
    )
      throw new Error('请先选择具体项目目录，不能将 Host 数据目录授权为工作区')
    if (protectedRoot && pathWithin(protectedRoot, temporary)) throw new Error('会话临时目录不能位于 Host 数据目录内')
    const profile = await accessProfile(options.mode, cwd, temporary, options.agentDir, protectedRoot)
    let launch: SandboxLaunch
    if (process.platform === 'darwin') {
      await access('/usr/bin/sandbox-exec')
      launch = { executable: '/usr/bin/sandbox-exec', args: ['-p', profile] }
    } else if (process.platform === 'linux') {
      launch = await linuxSandboxLaunch({ ...options, cwd, temporary })
    } else throw new Error(`当前平台不支持受限权限：${process.platform}`)
    const sandbox = new SandboxProcess(options.mode, cwd, temporary, launch, protectedRoot)
    let diagnostic = ''
    const result = await sandbox.run('/usr/bin/true', [], {
      cwd,
      onData: (chunk) => {
        diagnostic = (diagnostic + chunk.toString()).slice(-4096)
      },
      timeout: 5,
    })
    if (result.exitCode !== 0) throw new Error(`沙箱启动检查失败：${diagnostic || result.exitCode}`)
    return sandbox
  },
}

/** 同时验证白名单写入、越界拒绝和 Linux socket 过滤，失败保留系统诊断。 */
export async function probeAccessSandbox(): Promise<SandboxCapability> {
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
    const denied = await run('/usr/bin/tee', [path.join(outside, 'original')])
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
    return {
      supported: false,
      reason: `受限权限不可用：${String(cause)}；请检查沙箱依赖和系统 namespace 策略后重启 Host`,
    }
  } finally {
    sandbox?.stopAll()
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {})
    if (outside) await rm(outside, { recursive: true, force: true }).catch(() => {})
  }
}
