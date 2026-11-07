import { spawn } from 'node:child_process'
import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { linuxSandboxLaunch } from './linux-sandbox'
import { restrictedProcessEnvironment, spawnManagedProcess, type ManagedProcess } from './managed-process'
import {
  assertExecutionRequirements,
  executionCapabilities,
  type ExecutionCapability,
  type ExecutionCapabilityReport,
} from '@pi-meme/contracts/execution-capabilities'
import type { AgentAccessMode } from '@pi-meme/contracts/agent-access'
import { storageLayoutRelativePaths } from '@pi-meme/contracts/storage-paths'
import { spawnWindowsProcess, type WindowsSandboxPolicy } from '@pi-meme/windows-native/process'
import { windowsSandboxEnvironment, windowsRuntimeReadPaths } from '@pi-meme/windows-native/sandbox'
import { windowsSandboxPolicy } from './windows-sandbox'
import { windowsNodeExecutable } from '@pi-meme/windows-native/runtime'

export type AccessSandboxOptions = {
  mode: AgentAccessMode
  cwd: string
  /** 会话临时目录，工作区写入白名单之一。 */
  temporary: string
  agentDir: string
  dataRoot?: string
  /** Host-selected immutable Node; no discovery from a business PATH. */
  nodePath?: string
  /** Additional Host/runtime roots; never granted as writable business directories. */
  protectedRoots?: string[]
  /** Immutable application code/runtime remains readable but cannot be replaced. */
  readOnlyRoots?: string[]
  /** Explicit narrow read-only resource snapshots inside private roots. */
  readableRoots?: string[]
  taskMode?: 'default' | 'plan'
  network?: 'allow' | 'deny'
  requirements?: readonly ExecutionCapability[]
  signal?: AbortSignal
}

export type SandboxRunOptions = {
  cwd: string
  input?: string
  env?: NodeJS.ProcessEnv
  timeout?: number
  signal?: AbortSignal
  onData: (chunk: Buffer) => void
}

export type SandboxCapability = { supported: boolean; reason?: string; report?: ExecutionCapabilityReport }

/** No backend may turn an unimplemented guarantee into a permission grant. */
export function executionCapabilityReport(available = true, reason?: string): ExecutionCapabilityReport {
  const platform = process.platform
  const backend =
    platform === 'darwin'
      ? 'seatbelt'
      : platform === 'linux'
        ? 'bubblewrap'
        : platform === 'win32'
          ? 'psec'
          : 'unavailable'
  const capabilities = Object.fromEntries(
    executionCapabilities.map((capability) => [capability, { status: 'unknown', reason: reason ?? '尚未探测' }]),
  ) as ExecutionCapabilityReport['capabilities']
  if (available && backend !== 'unavailable') {
    for (const capability of ['filesystem-write-boundary', 'environment-isolation', 'network-deny'] as const)
      capabilities[capability] = { status: 'enforced' }
    capabilities['host-secrets'] = { status: 'unknown', reason: '保护已知私有目录；未证明硬链接别名读取隔离' }
    capabilities['process-tree'] =
      platform === 'darwin'
        ? { status: 'unknown', reason: '仅回收同一进程组，不能保证自行脱离的后代' }
        : { status: 'enforced' }
    capabilities['hardlink-write-boundary'] =
      platform === 'win32'
        ? { status: 'enforced' }
        : { status: 'unsupported', reason: '路径沙箱不能保证项目内硬链接不会修改外部同一 inode' }
    capabilities['unix-socket-deny'] =
      platform === 'linux' || platform === 'win32'
        ? { status: 'enforced' }
        : { status: 'unknown', reason: '未单独验证 AF_UNIX 边界' }
  }
  return { backend, platform, architecture: process.arch, checkedAt: new Date().toISOString(), capabilities }
}

export interface AccessSandboxOperations {
  readonly workspace: string
  readonly report?: ExecutionCapabilityReport
  startStdio?: (
    executable: string,
    args: string[],
    options: { cwd: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal },
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
    options: Pick<SandboxRunOptions, 'cwd' | 'env' | 'onData' | 'signal'>,
  ) => Promise<ManagedProcess>
  stopAll: () => Promise<void>
  assertWritable: (target: string) => Promise<void>
  mkdir: (target: string, signal?: AbortSignal) => Promise<void>
  writeFile: (
    target: string,
    content: string,
    signal?: AbortSignal,
    expected?: { dev: string; ino: string; revision?: string } | null,
  ) => Promise<void>
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

/** Resolve existing ancestors without requiring a future protected directory to exist. */
async function resolvePolicyPath(target: string): Promise<string> {
  let current = path.resolve(target)
  const tail: string[] = []
  for (;;) {
    try {
      return path.join(await realpath(current), ...tail)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(current) === current) throw cause
      tail.unshift(path.basename(current))
      current = path.dirname(current)
    }
  }
}

/** 写入根目录先解析符号链接。 */
async function accessProfile(
  mode: AccessSandboxOptions['mode'],
  cwd: string,
  temporary: string,
  agentDir: string,
  dataRoot?: string,
) {
  if (mode === 'full-access') return '(version 1)\n(allow default)'
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

/** Fixed helper: untrusted content only enters stdin, never the program source. */
const atomicWriteHelper = `
const fs = require('node:fs');
const crypto = require('node:crypto');
const target = process.argv[1];
const expected = process.argv[2] ? JSON.parse(process.argv[2]) : undefined;
if (expected === undefined) throw new Error('permission-denied: 写入缺少批准对象');
const content = fs.readFileSync(0);
if (content.length > 67108864) throw new Error('permission-denied: 写入超过安全检查上限');
const stamp = stat => [stat.dev,stat.ino,stat.nlink,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
const digest = fd => {
  const hash = crypto.createHash('sha256');
  const chunk = Buffer.alloc(65536); let offset = 0;
  for (;;) {
    const count = fs.readSync(fd, chunk, 0, chunk.length, offset);
    if (!count) break;
    offset += count;
    if (offset > 67108864) throw new Error('permission-denied: 文件超过安全检查上限');
    hash.update(chunk.subarray(0, count));
  }
  return hash.digest('hex');
};
let fd;
try {
  fd = fs.openSync(target, fs.constants.O_RDWR | (expected === null ? fs.constants.O_CREAT | fs.constants.O_EXCL : 0) |
    (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0), 384);
  const before = fs.fstatSync(fd, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || before.ino === 0n)
    throw new Error('permission-denied: 写入对象不是可核对的普通单链接文件');
  if (expected && (String(before.dev) !== expected.dev || String(before.ino) !== expected.ino))
    throw new Error('permission-denied: 写入对象与批准对象不匹配');
  if (expected && expected.revision && digest(fd) !== expected.revision)
    throw new Error('permission-denied: 文件内容已变化，请重新读取');
  if (stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(before))
    throw new Error('permission-denied: 文件在核对期间变化');
  // All content IO stays on this descriptor. Cancellation can leave a partial write; never reopen or roll back by name.
  for (let offset = 0; offset < content.length;) {
    const count = fs.writeSync(fd, content, offset, content.length - offset, offset);
    if (!count) throw new Error('写入未前进，结果未知');
    offset += count;
  }
  fs.ftruncateSync(fd, content.length);
  fs.fsyncSync(fd);
  const saved = fs.fstatSync(fd, { bigint: true });
  const actual = digest(fd);
  const named = fs.lstatSync(target, { bigint: true });
  if (actual !== crypto.createHash('sha256').update(content).digest('hex') || saved.nlink !== 1n ||
      stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(saved) || !named.isFile() || named.nlink !== 1n ||
      named.dev !== saved.dev || named.ino !== saved.ino)
    throw new Error('permission-denied: 保存对象或内容已变化，结果未知');
} finally { if (fd !== undefined) fs.closeSync(fd); }
`

/** 通用路径校验、文件工具与子进程清理；平台后端只生成启动参数。 */
class SandboxProcess implements AccessSandboxOperations {
  private readonly running = new Set<() => void>()
  private readonly executions = new Set<Promise<unknown>>()
  private readonly managed = new Set<Promise<unknown>>()
  private readonly pendingWindowsStarts = new Set<AbortController>()
  private stopGeneration = 0
  private capabilityReport?: ExecutionCapabilityReport

  constructor(
    private readonly mode: AccessSandboxOptions['mode'],
    private readonly cwd: string,
    private readonly temporary: string,
    private readonly launch: SandboxLaunch,
    private readonly privateRoots: readonly string[],
    private readonly dataRoot?: string,
    private readonly fileNode?: string,
    private readonly readOnlyRoots: readonly string[] = [],
  ) {}

  get report(): ExecutionCapabilityReport | undefined {
    return this.capabilityReport ? structuredClone(this.capabilityReport) : undefined
  }

  publishReport(report: ExecutionCapabilityReport) {
    this.capabilityReport = structuredClone(report)
  }

  /** 只读展示用的工作区路径。 */
  get workspace() {
    return this.cwd
  }

  private environment(env?: NodeJS.ProcessEnv) {
    const result = restrictedProcessEnvironment(this.temporary, env)
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

  private async startWindows(
    executable: string,
    args: string[],
    options: { cwd: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal },
  ) {
    const generation = this.stopGeneration
    const controller = new AbortController()
    this.pendingWindowsStarts.add(controller)
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
    const starting = (async () => {
      signal.throwIfAborted()
      const cwd = await realpath(options.cwd)
      const read = [...this.launch.windows!.read, ...(await windowsRuntimeReadPaths(executable))]
      signal.throwIfAborted()
      const child = await spawnWindowsProcess(executable, args, {
        cwd,
        env: windowsSandboxEnvironment(this.temporary, options.env),
        signal,
        sandbox: {
          ...this.launch.windows!,
          read,
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
      this.pendingWindowsStarts.delete(controller)
      this.executions.delete(starting)
    }
  }

  async startStdio(
    executable: string,
    args: string[],
    options: { cwd: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal },
  ) {
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
    const generation = this.stopGeneration
    options.signal?.throwIfAborted()
    const cwd = await realpath(options.cwd)
    options.signal?.throwIfAborted()
    if (generation !== this.stopGeneration) throw new Error('受限进程启动已取消')
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
    options.signal?.addEventListener('abort', kill, { once: true })
    if (options.signal?.aborted) kill()
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
      options.signal?.removeEventListener('abort', kill)
    })
    this.executions.add(completion)
    void completion.finally(() => this.executions.delete(completion)).catch(() => {})
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    if (generation !== this.stopGeneration || options.signal?.aborted) {
      kill()
      await completion
      throw new Error('受限进程启动已取消')
    }
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

  async startManaged(
    executable: string,
    args: string[],
    options: Pick<SandboxRunOptions, 'cwd' | 'env' | 'onData' | 'signal'>,
  ) {
    if (this.launch.windows) {
      const child = await this.startWindows(executable, args, options)
      child.stdin.on('error', () => {})
      child.stdin.end()
      child.stdout.on('data', options.onData)
      child.stderr.on('data', options.onData)
      return child
    }
    const generation = this.stopGeneration
    const starting = (async () => {
      options.signal?.throwIfAborted()
      const cwd = await realpath(options.cwd)
      options.signal?.throwIfAborted()
      if (generation !== this.stopGeneration) throw new Error('受限进程启动已取消')
      const launchArgs = [...this.launch.args]
      if (this.launch.seccomp) launchArgs[launchArgs.indexOf('--chdir') + 1] = cwd
      const child = await spawnManagedProcess(this.launch.executable, [...launchArgs, executable, ...args], {
        cwd,
        env: this.environment(options.env),
        onData: options.onData,
        seccomp: this.launch.seccomp,
      })
      options.signal?.addEventListener('abort', child.kill, { once: true })
      this.running.add(child.kill)
      void child.completion
        .finally(() => {
          this.running.delete(child.kill)
          options.signal?.removeEventListener('abort', child.kill)
        })
        .catch(() => {})
      this.managed.add(child.completion)
      void child.completion.finally(() => this.managed.delete(child.completion)).catch(() => {})
      if (generation !== this.stopGeneration || options.signal?.aborted) {
        child.kill()
        await child.completion
        throw new Error('受限进程启动已取消')
      }
      return child
    })()
    this.executions.add(starting)
    try {
      return await starting
    } finally {
      this.executions.delete(starting)
    }
  }

  /** 在沙箱里运行进程；取消、超时和进程退出都会终止整个进程组。 */
  async run(executable: string, args: string[], options: SandboxRunOptions): Promise<{ exitCode: number }> {
    const generation = this.stopGeneration
    options.signal?.throwIfAborted()
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
    options.signal?.throwIfAborted()
    if (generation !== this.stopGeneration) throw new Error('受限进程启动已取消')
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
    for (const controller of this.pendingWindowsStarts) controller.abort()
    for (const kill of this.running) kill()
    await Promise.allSettled([...this.executions, ...this.managed])
  }

  /** Full may write business paths; every mode retains the private-root prohibition. */
  async assertWritable(target: string) {
    if (this.mode === 'read-only') throw new Error(`当前权限禁止修改本地文件：${target}`)
    const current = await resolvePolicyPath(path.resolve(this.cwd, target))
    const inside = (root: string) => {
      const relative = path.relative(root, current)
      return (
        relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
      )
    }
    if (this.readOnlyRoots.some((root) => pathWithin(root, current)))
      throw new Error(`当前权限不允许替换应用只读运行时：${target}`)
    for (const root of this.privateRoots) {
      const standalone =
        this.dataRoot &&
        pathWithin(root, this.cwd) &&
        pathWithin(path.join(this.dataRoot, storageLayoutRelativePaths.standaloneWorkspacesDirectory), this.cwd) &&
        pathWithin(this.cwd, current)
      if (pathWithin(root, current) && !standalone) throw new Error(`当前权限不允许写入应用私有路径：${target}`)
    }
    if (this.mode !== 'full-access' && !inside(this.cwd) && !inside(this.temporary))
      throw new Error(`当前权限不允许写入项目外路径：${target}`)
  }

  async mkdir(target: string, signal?: AbortSignal) {
    target = path.resolve(this.cwd, target)
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

  async writeFile(
    target: string,
    content: string,
    signal?: AbortSignal,
    expected?: { dev: string; ino: string; revision?: string } | null,
  ) {
    target = path.resolve(this.cwd, target)
    await this.assertWritable(target)
    if (!this.fileNode) throw new Error('sandbox-unavailable: 固定文件写入 Node 运行时不可用')
    await this.fileCommand(
      this.fileNode,
      [
        '--disable-sigusr1',
        '--no-addons',
        '--input-type=commonjs',
        '-e',
        atomicWriteHelper,
        target,
        JSON.stringify(expected) ?? '',
      ],
      target,
      content,
      signal,
    )
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
    if (options.signal?.aborted) throw new Error('aborted')
    if (process.platform === 'win32' && options.mode === 'full-access')
      throw new Error('sandbox-unavailable: Windows PSEC 尚不能兑现 Full 广泛写入与私有根拒绝的组合')
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
    const fileNode =
      options.mode === 'read-only'
        ? undefined
        : options.nodePath
          ? await realpath(options.nodePath)
          : await windowsNodeExecutable()
    const networkDenied =
      options.taskMode === 'plan' || options.network === 'deny' || options.requirements?.includes('network-deny')
    let profile = await accessProfile(options.mode, cwd, temporary, options.agentDir, protectedRoot)
    const privateRoots: string[] = []
    for (const candidate of [protectedRoot, options.agentDir, ...(options.protectedRoots ?? [])]) {
      if (!candidate) continue
      privateRoots.push(await resolvePolicyPath(candidate))
    }
    const readOnlyRoots = await Promise.all(
      [...(options.readOnlyRoots ?? []), ...(fileNode ? [fileNode] : [])].map(resolvePolicyPath),
    )
    const readableRoots = await Promise.all((options.readableRoots ?? []).map(resolvePolicyPath))
    for (const readable of readableRoots) {
      if (
        !privateRoots.some((root) => pathWithin(root, readable)) ||
        privateRoots.some((root) => pathWithin(readable, root))
      )
        throw new Error('sandbox-unavailable: 资源读取例外必须严格位于私有根的子路径内，不能覆盖私有根')
    }
    for (const root of [...readOnlyRoots, ...readableRoots]) {
      if (pathWithin(root, temporary)) throw new Error('sandbox-unavailable: 会话临时目录不能位于只读运行时内')
      profile += `\n(deny file-write* (subpath ${JSON.stringify(root)}))`
    }
    for (const root of privateRoots) {
      const standalone =
        protectedRoot &&
        pathWithin(root, cwd) &&
        pathWithin(path.join(protectedRoot, storageLayoutRelativePaths.standaloneWorkspacesDirectory), cwd)
      if ((pathWithin(root, cwd) && !standalone) || pathWithin(root, temporary))
        throw new Error('sandbox-unavailable: 工作区或临时目录位于受保护目录内')
      const exceptions = [
        ...(standalone ? [cwd] : []),
        ...(root === protectedRoot ? [path.join(root, storageLayoutRelativePaths.attachmentsDirectory)] : []),
        ...readableRoots.filter((entry) => pathWithin(root, entry)),
      ]
      const readExceptions = [
        ...exceptions.map((entry) => `(require-not (subpath ${JSON.stringify(entry)}))`),
        ...(fileNode && pathWithin(root, fileNode) ? [`(require-not (literal ${JSON.stringify(fileNode)}))`] : []),
      ]
      const selector = readExceptions.length
        ? `(require-all (subpath ${JSON.stringify(root)}) ${readExceptions.join(' ')})`
        : `(subpath ${JSON.stringify(root)})`
      profile += `\n(deny file-read* ${selector})`
      profile += `\n(deny file-write* ${standalone ? `(require-all (subpath ${JSON.stringify(root)}) (require-not (subpath ${JSON.stringify(cwd)})))` : `(subpath ${JSON.stringify(root)})`})`
    }
    if (networkDenied) profile += '\n(deny network*)'
    let launch: SandboxLaunch
    if (process.platform === 'darwin') {
      await access('/usr/bin/sandbox-exec')
      launch = { executable: '/usr/bin/sandbox-exec', args: ['-p', profile] }
    } else if (process.platform === 'linux') {
      launch = await linuxSandboxLaunch(
        {
          ...options,
          cwd,
          temporary,
          protectedRoots: privateRoots,
          readOnlyRoots,
          readableRoots,
          network: networkDenied ? 'deny' : 'allow',
        },
        fileNode,
      )
    } else if (process.platform === 'win32') {
      launch = {
        executable: fileNode ?? (await windowsNodeExecutable()),
        args: [],
        windows: await windowsSandboxPolicy({
          ...options,
          cwd,
          temporary,
          readOnlyRoots,
          readableRoots,
          network: networkDenied ? 'deny' : 'allow',
        }),
      }
    } else throw new Error(`当前平台不支持受限权限：${process.platform}`)
    const sandbox = new SandboxProcess(options.mode, cwd, temporary, launch, privateRoots, protectedRoot, fileNode, [
      ...readOnlyRoots,
      ...readableRoots,
    ])
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
        signal: options.signal,
      },
    )
    if (result.exitCode !== 0)
      throw new Error(`沙箱启动检查失败（${result.exitCode}）：${diagnostic.trim() || '进程未返回诊断'}`)
    const report = executionCapabilityReport()
    try {
      assertExecutionRequirements(report, options.requirements ?? [])
    } catch (cause) {
      await sandbox.stopAll()
      throw cause
    }
    sandbox.publishReport(report)
    return sandbox
  },
}

/** 同时验证白名单写入、越界拒绝和 Linux socket 过滤，失败保留系统诊断。 */
export async function probeAccessSandbox(
  options: { timeoutMs?: number; signal?: AbortSignal; network?: 'allow' | 'deny' } = {},
): Promise<SandboxCapability> {
  const controller = new AbortController()
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 20000, 60000))
  let timer: ReturnType<typeof setTimeout> | undefined
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) controller.abort()
  try {
    const result = await Promise.race([
      probeAccessSandboxInternal(controller.signal, options.network),
      new Promise<SandboxCapability>((resolve) => {
        const unavailable = () => resolve({ supported: false, reason: '沙箱探测取消或超时' })
        controller.signal.addEventListener('abort', unavailable, { once: true })
        if (controller.signal.aborted) unavailable()
        timer = setTimeout(() => controller.abort(), timeoutMs)
      }),
    ])
    return { ...result, report: executionCapabilityReport(result.supported, result.reason) }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
}

async function probeAccessSandboxInternal(signal: AbortSignal, network?: 'allow' | 'deny'): Promise<SandboxCapability> {
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
      network,
      signal,
    })
    if (signal.aborted) throw new Error('沙箱探测已取消')
    await sandbox.writeFile(path.join(cwd, 'allowed'), 'allowed', signal, null)
    if ((await readFile(path.join(cwd, 'allowed'), 'utf8')) !== 'allowed') throw new Error('工作区写入探测失败')
    let diagnostic = ''
    const run = (executable: string, args: string[]) =>
      sandbox!.run(executable, args, {
        cwd,
        signal,
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
