import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { promisify } from 'node:util'
import { WindowsCommandProcess, spawnWindowsProcess } from '@pi-meme/windows-native/process'
import { access, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { homedir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { SshConnectionInput } from '@pi-meme/contracts/ssh-connections'

type SshTarget = Pick<SshConnectionInput, 'target' | 'port' | 'identityFile'>
const execute = promisify(execFile)
export type SshProcess = ChildProcess | WindowsCommandProcess

export async function spawnSshProcess(
  executable: string,
  args: string[],
  options: SpawnOptions,
  run?: typeof spawn,
): Promise<SshProcess> {
  if (process.platform === 'win32' && !run) {
    const child = new WindowsCommandProcess(
      await spawnWindowsProcess(executable, args, {
        cwd: String(options.cwd ?? process.cwd()),
        env: options.env ?? process.env,
      }),
    )
    if (Array.isArray(options.stdio) && options.stdio[0] === 'ignore') child.stdin.end()
    return child
  }
  return (run ?? spawn)(executable, args, options)
}

export class SshError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message)
  }
}
export type SshTunnel = { endpoint: string; closed: Promise<SshError>; stop: () => Promise<void> }
export type SshTunnelStarter = (connection: SshTarget, remotePort: number, signal: AbortSignal) => Promise<SshTunnel>

export function sshUnavailableReason() {
  return process.platform === 'win32'
    ? '未找到 Windows 原生 OpenSSH，请安装 Windows 可选功能“OpenSSH 客户端”后重启应用。'
    : '本机服务未找到系统 OpenSSH，请安装后重试'
}

export async function findSshExecutable(): Promise<string | undefined> {
  const directories = [
    ...(process.platform === 'win32' && process.env.SystemRoot
      ? [path.join(process.env.SystemRoot, 'System32/OpenSSH')]
      : []),
    ...(process.env.PATH ?? '/usr/bin:/bin').split(path.delimiter),
  ]
  for (const directory of directories) {
    if (!path.isAbsolute(directory)) continue
    const file = path.join(directory, process.platform === 'win32' ? 'ssh.exe' : 'ssh')
    try {
      await access(file, constants.X_OK)
      if (process.platform === 'win32') {
        const version = await execute(file, ['-V'], { timeout: 5000, windowsHide: true, maxBuffer: 8192 })
        if (!/^OpenSSH_for_Windows_/m.test(version.stdout + version.stderr)) continue
      }
      return file
    } catch {
      // PATH 中不可执行的候选不作为 ssh 使用。
    }
  }
}

export function sshFailure(stderr: string) {
  if (/UNPROTECTED PRIVATE KEY FILE|Permissions for .* too open|bad permissions.*key/i.test(stderr))
    return new SshError('identity-permissions', 'SSH 私钥文件权限过宽，请在本机检查该文件的 Windows ACL 后重试')
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|No .*host key is known/i.test(stderr))
    return new SshError('host-key', 'SSH 主机指纹未受信任或已变化，请先在本机终端核实')
  if (/Permission denied|no supported authentication|sign_and_send_pubkey|agent refused/i.test(stderr))
    return new SshError('ssh-auth', 'SSH 身份验证失败，请检查本机密钥和 SSH agent')
  if (/Bad configuration|Bad owner|Bad permissions|Bad SSH|Could not resolve hostname/i.test(stderr))
    return new SshError('ssh-config', 'SSH 配置或目标无效，请检查本机 SSH 配置')
  return new SshError('ssh-network', 'SSH 连接已中断，请检查网络、SSH 服务和远程服务', true)
}

async function unusedPort() {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('无法分配 SSH 本地端口')
  await new Promise<void>((resolve, reject) => server.close((cause) => (cause ? reject(cause) : resolve())))
  return address.port
}

function tcpReady(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const finish = (ready: boolean) => {
      socket.destroy()
      resolve(ready)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(200, () => finish(false))
  })
}

type SignalGroup = (pid: number, signal: NodeJS.Signals | 0) => boolean
function signalGroup(pid: number, signal: NodeJS.Signals | 0) {
  try {
    process.kill(-pid, signal)
    return true
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw new SshError('ssh-cleanup', '无法清理 SSH 进程组，请检查本机进程权限')
  }
}
export async function stopChild(child: SshProcess, send: SignalGroup = signalGroup) {
  if (child instanceof WindowsCommandProcess) {
    await child.native.stop()
    return
  }
  if (child.pid === undefined) return
  // ssh 与它创建的代理命令均属于本应用独立进程组，不使用用户共享 Master。
  if (!send(child.pid, 'SIGTERM')) return
  for (let check = 0; check < 40; check++) {
    if (!send(child.pid, 0)) return
    await delay(25)
  }
  if (!send(child.pid, 'SIGKILL')) return
  for (let check = 0; check < 40; check++) {
    if (!send(child.pid, 0)) return
    await delay(25)
  }
  throw new SshError('ssh-cleanup', 'SSH 进程组未能退出，请检查本机进程')
}

function identityFilePath(value: string) {
  return value.startsWith('~/') ? path.join(homedir(), value.slice(2)) : value
}

export function sshArguments(connection: SshTarget) {
  const args = [
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'PermitLocalCommand=no',
    '-o',
    'RemoteCommand=none',
    '-o',
    'ForwardAgent=no',
    '-o',
    'ForwardX11=no',
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPath=none',
    '-o',
    'ControlPersist=no',
    '-o',
    'ForkAfterAuthentication=no',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    '-o',
    'ExitOnForwardFailure=yes',
  ]
  if (connection.port !== undefined) args.push('-p', String(connection.port))
  if (connection.identityFile) args.push('-i', identityFilePath(connection.identityFile))
  return args
}

type SshValidationOptions = {
  configFile?: string
  spawn?: typeof spawn
  executable?: () => Promise<string | undefined>
  signalGroup?: SignalGroup
  preflightTimeoutMs?: number
}

export async function validateSshConnection(
  connection: SshTarget,
  signal: AbortSignal,
  options: SshValidationOptions = {},
) {
  const send = options.signalGroup ?? signalGroup
  signal.throwIfAborted()
  const executable = await (options.executable ?? findSshExecutable)()
  if (!executable) throw new SshError('ssh-unavailable', sshUnavailableReason())
  signal.throwIfAborted()
  if (connection.identityFile) {
    const file = identityFilePath(connection.identityFile)
    try {
      if (!(await stat(file)).isFile()) throw new Error('不是文件')
      await access(file, constants.R_OK)
    } catch {
      throw new SshError('identity-file', '指定的身份文件不存在或不可读，请检查本机路径')
    }
    signal.throwIfAborted()
  }
  if (options.configFile && !path.isAbsolute(options.configFile))
    throw new SshError('ssh-config', 'SSH 配置路径必须是绝对路径')
  const base = [...(options.configFile ? ['-F', options.configFile] : []), ...sshArguments(connection)]
  const config = await spawnSshProcess(
    executable,
    ['-G', ...base, '--', connection.target],
    {
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
    options.spawn,
  )
  let configStopping: Promise<void> | undefined
  const stopConfig = () => (configStopping ??= stopChild(config, send))
  const abortConfig = () => {
    void stopConfig().catch(() => {})
  }
  let preflightTimeout: ReturnType<typeof setTimeout> | undefined
  signal.addEventListener('abort', abortConfig, { once: true })
  if (signal.aborted) abortConfig()
  let output = ''
  let stderr = ''
  config.stdout?.on('data', (chunk: Buffer) => {
    if (output.length < 256 * 1024) output += chunk.toString()
    else void stopConfig().catch(() => {})
  })
  config.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length < 8192) stderr += chunk.toString()
  })
  try {
    await new Promise<void>((resolve, reject) => {
      preflightTimeout = setTimeout(() => {
        reject(new SshError('ssh-config-timeout', 'SSH 配置检查超时，请检查 Match 或代理命令'))
        void stopConfig().catch(() => {})
      }, options.preflightTimeoutMs ?? 10000)
      config.once('error', () => reject(new SshError('ssh-unavailable', '无法启动系统 OpenSSH')))
      config.once('close', (code) => (code === 0 ? resolve() : reject(sshFailure(stderr))))
      if (config.exitCode !== null) {
        setImmediate(() => {
          if (config.exitCode === 0) resolve()
          else reject(sshFailure(stderr))
        })
      }
    })
    signal.throwIfAborted()
    if (/^(?:localforward|remoteforward|dynamicforward)\s+(?!none(?:\s|$))/im.test(output))
      throw new SshError('forwarding-conflict', '此 SSH 配置含额外端口转发，请使用不含转发配置的主机别名')
  } finally {
    clearTimeout(preflightTimeout)
    signal.removeEventListener('abort', abortConfig)
    await stopConfig()
  }
  return { executable, args: base }
}

/** 只有用户启用连接时执行；发现配置阶段不调用此函数。 */
export function createSshTunnelStarter(
  options: SshValidationOptions & {
    allocatePort?: () => Promise<number>
    ready?: (port: number) => Promise<boolean>
  } = {},
): SshTunnelStarter {
  const send = options.signalGroup ?? signalGroup
  return async (connection, remotePort, signal) => {
    const { executable, args: base } = await validateSshConnection(connection, signal, options)
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted()
      const port = await (options.allocatePort ?? unusedPort)()
      signal.throwIfAborted()
      const child = await spawnSshProcess(
        executable,
        ['-N', ...base, '-L', `127.0.0.1:${port}:127.0.0.1:${remotePort}`, '--', connection.target],
        { shell: false, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
        options.spawn,
      )
      let failure: SshError | undefined
      let errors = ''
      const closed = new Promise<SshError>((resolve) => {
        child.stderr?.on('data', (chunk: Buffer) => {
          if (errors.length < 8192) errors += chunk.toString()
        })
        child.once('error', () => {
          failure = new SshError('ssh-unavailable', '无法启动系统 OpenSSH')
          resolve(failure)
        })
        child.once('close', () => {
          failure ??= sshFailure(errors)
          resolve(failure)
        })
      })
      let stopping: Promise<void> | undefined
      const stop = () => (stopping ??= stopChild(child, send))
      const abort = () => {
        void stop().catch(() => {})
      }
      signal.addEventListener('abort', abort, { once: true })
      void closed.then(() => signal.removeEventListener('abort', abort))
      try {
        for (let check = 0; check < 120; check++) {
          signal.throwIfAborted()
          if (failure) throw failure
          if (await (options.ready ?? tcpReady)(port)) {
            signal.throwIfAborted()
            if (failure) throw failure
            return { endpoint: `http://127.0.0.1:${port}`, closed, stop }
          }
          await delay(100, undefined, { signal })
        }
        throw new SshError('ssh-timeout', 'SSH 通道建立超时', true)
      } catch (cause) {
        await stop()
        signal.removeEventListener('abort', abort)
        if (!signal.aborted && /Address already in use|cannot listen to port/i.test(errors) && attempt < 2) continue
        throw cause
      }
    }
    throw new SshError('ssh-port', 'SSH 本地端口分配失败', true)
  }
}
