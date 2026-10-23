import { spawn } from 'node:child_process'
import { closeSync, writeSync } from 'node:fs'
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import type { Readable } from 'node:stream'
import lockfile from 'proper-lockfile'
import { sshHostRuntimeHomeRelativeDirectory, storageLayoutRelativePaths } from '@pi-meme/contracts/storage-paths'
import { readLocalHostStatus } from '@pi-meme/host/host-status'
import { startHostServer } from '@pi-meme/host/server'
import { serverOptions } from './server-options'

declare const __PI_MEME_VERSION__: string

const protocolVersion = 1
const timeoutMs = 60000
const conflictMessage = '固定数据目录已有其他 Host 或 SSH 启动锁未释放；不会接管手工启动的 Host'

function conflict(message: string) {
  return Object.assign(new Error(message), { code: 'host-conflict' })
}
const root = path.join(homedir(), '.pi-meme')
const runtime = path.join(homedir(), sshHostRuntimeHomeRelativeDirectory)
const descriptorFile = path.join(runtime, 'runtime.json')
const version =
  typeof __PI_MEME_VERSION__ === 'string'
    ? __PI_MEME_VERSION__
    : (JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version

type BootstrapResult = {
  protocolVersion: 1
  port: number
  hostId: string
  token: string
  version: string
}
type RuntimeDescriptor = Omit<BootstrapResult, 'token'> & { pid: number; instanceId: string }

function errorCode(cause: unknown) {
  return cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined
}

async function readJson(stream: Readable, channel: string, limit = 4096): Promise<unknown> {
  let bytes = 0
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    const value = Buffer.from(chunk)
    bytes += value.length
    if (bytes > limit) throw new Error('SSH 引导输入超过大小限制')
    chunks.push(value)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new Error(`${channel}未返回有效 JSON`)
  }
}

function validResult(value: unknown): value is BootstrapResult {
  if (!value || typeof value !== 'object') return false
  const result = value as BootstrapResult
  return (
    result.protocolVersion === protocolVersion &&
    Number.isInteger(result.port) &&
    result.port > 0 &&
    result.port <= 65535 &&
    typeof result.hostId === 'string' &&
    Boolean(result.hostId) &&
    typeof result.token === 'string' &&
    result.token.length >= 32 &&
    result.token.length <= 4096 &&
    typeof result.version === 'string'
  )
}

async function privatePath(file: string) {
  const info = await lstat(file)
  if (!info.isFile() || (info.mode & 0o777) !== 0o600 || (process.getuid && info.uid !== process.getuid()))
    throw conflict('SSH Host 运行信息权限或所有者无效，拒绝复用')
}

async function readDescriptor(): Promise<RuntimeDescriptor | undefined> {
  try {
    await privatePath(descriptorFile)
    const body = await readFile(descriptorFile, 'utf8')
    let value: RuntimeDescriptor
    try {
      if (Buffer.byteLength(body) > 4096) throw new Error('运行信息过大')
      value = JSON.parse(body) as RuntimeDescriptor
    } catch {
      throw conflict('SSH Host 运行信息无效，拒绝复用')
    }
    if (
      !value ||
      typeof value !== 'object' ||
      value.protocolVersion !== protocolVersion ||
      !Number.isInteger(value.pid) ||
      value.pid < 1 ||
      !Number.isInteger(value.port) ||
      value.port < 1 ||
      value.port > 65535 ||
      typeof value.hostId !== 'string' ||
      !value.hostId ||
      typeof value.instanceId !== 'string' ||
      !value.instanceId ||
      typeof value.version !== 'string' ||
      'token' in value
    )
      throw conflict('SSH Host 运行信息无效，拒绝复用')
    return value
  } catch (cause) {
    if (errorCode(cause) === 'ENOENT') return undefined
    throw cause
  }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    if (errorCode(cause) === 'ESRCH') return false
    throw cause
  }
}

async function reuse(descriptor: RuntimeDescriptor): Promise<BootstrapResult> {
  if (descriptor.version !== version) throw conflict('已有 SSH Host 的版本不同，请停止原 SSH Host 后重试')
  const status = await readLocalHostStatus(`http://127.0.0.1:${descriptor.port}`)
  if (
    !status ||
    status.hostId !== descriptor.hostId ||
    status.instanceId !== descriptor.instanceId ||
    status.owner !== 'server' ||
    status.dataRoot !== (await realpath(root)) ||
    (await readFile(path.join(root, storageLayoutRelativePaths.hostIdFile), 'utf8')) !== descriptor.hostId
  )
    throw conflict('SSH Host 与固定数据目录身份不匹配，拒绝复用')
  const authFile = path.join(root, storageLayoutRelativePaths.authFile)
  await privatePath(authFile)
  let credentials: unknown
  try {
    credentials = JSON.parse(await readFile(authFile, 'utf8')) as unknown
  } catch {
    throw conflict('无法读取 SSH Host 凭据或凭据 JSON 无效，原文件未修改')
  }
  const token =
    credentials && typeof credentials === 'object' && 'host:token' in credentials
      ? credentials['host:token']
      : undefined
  if (typeof token !== 'string' || token.length < 32 || token.length > 4096)
    throw conflict('SSH Host 访问令牌无效，原文件未修改')
  return { protocolVersion, port: descriptor.port, hostId: descriptor.hostId, token, version }
}

async function startDetached(): Promise<BootstrapResult> {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PI_MEME_')))
  environment.PATH = `${path.dirname(process.execPath)}${path.delimiter}${environment.PATH ?? ''}`
  const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), '--host'], {
    cwd: homedir(),
    env: environment,
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
  })
  child.unref()
  const stream = child.stdio[3] as Readable
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      readJson(stream, 'SSH Host 就绪通道'),
      new Promise<never>((_, reject) => {
        child.once('error', () => reject(new Error('无法启动包内 SSH Host 进程')))
        timer = setTimeout(() => reject(new Error('SSH Host 启动超时，请稍后重试')), timeoutMs)
      }),
    ])
    if (!validResult(result)) {
      if (result && typeof result === 'object' && 'error' in result && typeof result.error === 'string')
        throw Object.assign(new Error(result.error), { code: 'code' in result ? result.code : 'host-start' })
      throw new Error('SSH Host 没有返回有效启动结果')
    }
    return result
  } finally {
    if (timer) clearTimeout(timer)
    stream.destroy()
  }
}

async function bootstrap() {
  const input = await readJson(process.stdin, 'SSH 引导输入')
  if (
    !input ||
    typeof input !== 'object' ||
    !('protocolVersion' in input) ||
    input.protocolVersion !== protocolVersion ||
    Object.keys(input).length !== 1
  )
    throw new Error('SSH 引导协议无效，只接受 protocolVersion: 1')
  await mkdir(runtime, { recursive: true, mode: 0o700 })
  const info = await lstat(runtime)
  if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid()))
    throw conflict('SSH Host 运行目录类型或所有者无效')
  await chmod(runtime, 0o700)
  const release = await lockfile.lock(runtime, {
    lockfilePath: path.join(runtime, 'bootstrap.lock'),
    stale: 30000,
    update: 5000,
    retries: { retries: 240, minTimeout: 250, maxTimeout: 250, factor: 1 },
  })
  try {
    const descriptor = await readDescriptor()
    if (descriptor && alive(descriptor.pid)) return await reuse(descriptor)
    const deadline = Date.now() + 35000
    for (;;) {
      try {
        return await startDetached()
      } catch (cause) {
        if (!descriptor || errorCode(cause) !== 'host-conflict' || Date.now() >= deadline) throw cause
        // 自有进程异常退出后，让原数据锁按原有心跳规则过期，不直接删除数据锁。
        await delay(1000)
      }
    }
  } finally {
    await release()
  }
}

function sendReady(value: unknown) {
  try {
    writeSync(3, `${JSON.stringify(value)}\n`)
  } catch {
    // 发起方已退出时，独立 Host 仍继续运行，下一次连接可复用。
  } finally {
    try {
      closeSync(3)
    } catch {
      // 私有就绪通道可能已经关闭。
    }
  }
}

async function detachedHost() {
  process.umask(0o077)
  const options = await serverOptions(import.meta.url, {})
  const owned = await startHostServer({
    ...options,
    dataRoot: root,
    hostname: '127.0.0.1',
    port: 0,
    localAutoLogin: false,
  })
  if (process.platform === 'linux' && !owned.host.pi.connection().restrictedAccessSupported) {
    await owned.dispose()
    throw Object.assign(new Error('Linux 受限沙箱不可用；请安装 bubblewrap 并允许非特权用户命名空间后重试'), {
      code: 'host-dependencies',
    })
  }
  const descriptor: RuntimeDescriptor = {
    protocolVersion,
    pid: process.pid,
    port: Number(new URL(owned.url).port),
    hostId: owned.host.hostId,
    instanceId: owned.host.instanceId,
    version,
  }
  const result: BootstrapResult = {
    protocolVersion,
    port: descriptor.port,
    hostId: descriptor.hostId,
    token: owned.token,
    version,
  }
  try {
    const temporary = `${descriptorFile}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(descriptor)}\n`, { mode: 0o600 })
    await rename(temporary, descriptorFile)
  } catch (cause) {
    await owned.dispose()
    throw cause
  }
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    void owned
      .dispose()
      .then(async () => {
        await rm(descriptorFile, { force: true })
        process.exit(0)
      })
      .catch(() => process.exit(1))
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  sendReady(result)
}

try {
  if (process.argv[2] === '--host') await detachedHost()
  else process.stdout.write(`${JSON.stringify(await bootstrap())}\n`)
} catch (cause) {
  const locked = ['ELOCKED', 'host-conflict'].includes(String(errorCode(cause)))
  const code = locked ? 'host-conflict' : errorCode(cause) === 'host-dependencies' ? 'host-dependencies' : 'host-start'
  const message =
    errorCode(cause) === 'ELOCKED'
      ? conflictMessage
      : process.argv[2] === '--host' && code !== 'host-dependencies'
        ? 'SSH Host 启动失败，请检查固定数据目录、包内运行时与文件权限'
        : cause instanceof Error
          ? cause.message
          : 'SSH 引导失败'
  if (process.argv[2] === '--host') sendReady({ code, error: message })
  else process.stderr.write(`${JSON.stringify({ code, message })}\n`)
  process.exit(1)
}
