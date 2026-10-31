import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Readable, Writable } from 'node:stream'
import type { JsonValue } from '@pi-meme/plugin-sdk/rpc'
import { checkedJson } from './operation'
import type { RestrictedRegistration } from '@pi-meme/contracts/plugin-call'
import {
  spawnWindowsProcess,
  WindowsCommandProcess,
  type WindowsSandboxPolicy,
  type WindowsProcess,
} from '@pi-meme/windows-native/process'

export type RestrictedLaunchOptions = {
  node: string
  entry: string
  workspace: string
  directory: string
  scratch: string
  writable: boolean
  readable?: boolean
  dataRoot?: string
}
export type RestrictedLaunch = {
  executable: string
  args: string[]
  env: NodeJS.ProcessEnv
  seccomp?: Buffer
  windowsSandbox?: WindowsSandboxPolicy
}
export type { RestrictedRegistration } from '@pi-meme/contracts/plugin-call'
export class RestrictedRunner extends EventEmitter {
  private child?: ChildProcess | WindowsCommandProcess
  private input?: Writable
  private pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (cause: Error) => void; cleanup: () => void }
  >()
  private scopes = new Map<string, AbortSignal>()
  private brokerCalls = new Map<string, { scope: string; controller: AbortController }>()
  private incoming = Buffer.alloc(0)
  private closing?: Promise<void>
  private ready?: Promise<RestrictedRegistration>
  private logs = ''
  private closed = false
  private starting?: Promise<WindowsProcess>
  constructor(
    private readonly options: RestrictedLaunchOptions & {
      launch: (options: RestrictedLaunchOptions) => Promise<RestrictedLaunch>
      initialize: Record<string, unknown>
      broker: (method: string, input: JsonValue, signal: AbortSignal) => Promise<unknown>
    },
  ) {
    super()
  }
  static get entry() {
    return (
      process.env.PI_MEME_PLUGIN_ENTRY ||
      path.join(
        typeof __dirname === 'string' ? __dirname : path.dirname(fileURLToPath(import.meta.url)),
        'restricted-entry.mjs',
      )
    )
  }
  start() {
    if (this.closed) return Promise.reject(new Error('scope-expired: 插件实例已释放'))
    this.ready ??= this.boot()
    return this.ready
  }
  private async boot(): Promise<RestrictedRegistration> {
    const initialize = { ...this.options.initialize }
    // 在父进程解析符号链接，避免受限 Node 导入入口时读取白名单外的祖先目录。
    for (const key of ['agent', 'server'])
      if (typeof initialize[key] === 'string') initialize[key] = await realpath(initialize[key])
    const launch = await this.options.launch(this.options)
    if (this.closed) throw new Error('scope-expired: 插件实例已释放')
    let native: WindowsProcess | undefined
    if (launch.windowsSandbox) {
      this.starting = spawnWindowsProcess(launch.executable, launch.args, {
        cwd: this.options.workspace,
        env: launch.env,
        sandbox: launch.windowsSandbox,
      })
      native = await this.starting
      if (this.closed) {
        await native.stop()
        throw new Error('scope-expired: 插件实例已释放')
      }
    }
    const child = native
      ? new WindowsCommandProcess(native)
      : spawn(launch.executable, launch.args, {
          cwd: this.options.workspace,
          env: launch.env,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
        })
    this.child = child
    this.input = child instanceof WindowsCommandProcess ? child.stdin : (child.stdio[4] as Writable)
    const output =
      child instanceof WindowsCommandProcess
        ? child.stdout
        : ((child.stdio as Array<Readable | Writable | null>)[5] as Readable)
    const fail = (cause: Error) => {
      for (const call of this.pending.values()) {
        call.cleanup()
        call.reject(cause)
      }
      this.pending.clear()
      this.emit('failed', cause)
    }
    child.once('error', fail)
    child.once('close', () => {
      this.child = undefined
      let detail = this.logs.slice(-1024)
      for (const location of [
        this.options.entry,
        this.options.directory,
        this.options.scratch,
        this.options.workspace,
        this.options.dataRoot,
      ]
        .filter((value): value is string => Boolean(value))
        .sort((a, b) => b.length - a.length))
        detail = detail.replaceAll(location, '<受限运行目录>')
      fail(new Error(`scope-expired: 受限插件进程已退出${detail ? `：${detail}` : ''}`))
    })
    this.input.on('error', () => {})
    if (!(child instanceof WindowsCommandProcess)) {
      const fd = child.stdio[3] as Writable
      fd.on('error', () => {})
      fd.end(launch.seccomp)
    }
    for (const stream of child instanceof WindowsCommandProcess ? [child.stderr] : [child.stdout!, child.stderr!])
      stream.on('data', (b: Buffer) => {
        this.logs = (this.logs + b.toString()).slice(-65536)
      })
    output.on('data', (chunk: Buffer) => {
      this.incoming = Buffer.concat([this.incoming, chunk])
      try {
        while (this.incoming.length >= 4) {
          const size = this.incoming.readUInt32BE(0)
          if (size > 4 * 1024 * 1024 || size === 0) throw new Error('payload-too-large: 受限响应超过限制')
          if (this.incoming.length < size + 4) break
          const message = JSON.parse(this.incoming.subarray(4, 4 + size).toString())
          this.incoming = this.incoming.subarray(4 + size)
          if (message.type === 'broker') {
            if (
              typeof message.id !== 'string' ||
              message.id.length > 128 ||
              typeof message.scope !== 'string' ||
              message.scope.length > 128 ||
              typeof message.method !== 'string' ||
              message.method.length > 64
            )
              throw new Error('invalid-output: broker 信封无效')
            void this.broker(message).catch((cause: unknown) => {
              fail(cause instanceof Error ? cause : new Error(String(cause)))
              void this.close()
            })
            continue
          }
          if (message.type === 'brokerCancel') {
            const call = this.brokerCalls.get(message.id)
            if (call && call.scope === message.scope) call.controller.abort()
            continue
          }
          if (message.type !== 'reply' || typeof message.id !== 'string')
            throw new Error('invalid-output: 受限协议帧无效')
          const call = this.pending.get(message.id)
          if (!call) continue
          this.pending.delete(message.id)
          call.cleanup()
          if (message.error) call.reject(new Error(String(message.error)))
          else call.resolve(message.value)
        }
      } catch (cause) {
        fail(cause as Error)
        void this.close()
      }
    })
    const signal = AbortSignal.timeout(5000)
    try {
      return (await this.call('initialize', initialize, signal)) as RestrictedRegistration
    } catch (cause) {
      await this.close()
      throw cause
    }
  }
  private async broker(message: { id: string; scope: string; method: string; input: JsonValue }) {
    const parent = this.scopes.get(message.scope)
    if (!parent || parent.aborted || this.closed) {
      this.send({ type: 'brokerReply', id: message.id, error: 'scope-expired: 调用已结束' })
      return
    }
    if (this.brokerCalls.has(message.id) || this.brokerCalls.size >= 64) {
      this.send({ type: 'brokerReply', id: message.id, error: 'invalid-input: broker 请求重复或过多' })
      return
    }
    const controller = new AbortController()
    const signal = AbortSignal.any([parent, controller.signal])
    this.brokerCalls.set(message.id, { scope: message.scope, controller })
    try {
      checkedJson(message.input, 1048576)
      const value = await this.options.broker(message.method, message.input, signal)
      if (!signal.aborted && this.scopes.has(message.scope)) this.send({ type: 'brokerReply', id: message.id, value })
    } catch (cause) {
      this.send({ type: 'brokerReply', id: message.id, error: String(cause) })
    } finally {
      this.brokerCalls.delete(message.id)
      controller.abort()
    }
  }
  private send(value: unknown) {
    const body = Buffer.from(JSON.stringify(value))
    if (body.length > 4 * 1024 * 1024) throw new Error('payload-too-large: 插件协议超过限制')
    const header = Buffer.alloc(4)
    header.writeUInt32BE(body.length)
    this.input?.write(Buffer.concat([header, body]))
  }
  call(method: string, input: unknown, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) return Promise.reject(new Error('cancelled: 插件调用已取消'))
    if (!this.child || this.closed) return Promise.reject(new Error('scope-expired: 插件实例已释放'))
    if (this.pending.size >= 64) return Promise.reject(new Error('permission-denied: 插件并发请求过多'))
    const id = randomUUID()
    const scope = new AbortController()
    const lifecycle =
      method === 'hook' && ['sessionStart', 'sessionEnd'].includes((input as { name?: string }).name ?? '')
    if (method !== 'initialize' && !lifecycle) this.scopes.set(id, AbortSignal.any([signal, scope.signal]))
    return new Promise((resolve, reject) => {
      let cancelTimer: ReturnType<typeof setTimeout> | undefined
      const abort = () => {
        signal.removeEventListener('abort', abort)
        this.scopes.delete(id)
        scope.abort()
        this.send({ type: 'cancel', id })
        reject(new Error('cancelled: 插件调用已取消'))
        cancelTimer = setTimeout(() => {
          if (this.pending.has(id)) void this.close()
        }, 100)
      }
      const cleanup = () => {
        clearTimeout(cancelTimer)
        signal.removeEventListener('abort', abort)
        this.scopes.delete(id)
        scope.abort()
      }
      this.pending.set(id, { resolve, reject, cleanup })
      signal.addEventListener('abort', abort, { once: true })
      this.send({ type: 'call', id, method, input })
    })
  }
  close() {
    this.closed = true
    this.closing ??= (async () => {
      if (this.starting && !this.child) {
        const native = await this.starting.catch(() => undefined)
        await native?.stop()
      }
      const child = this.child
      if (!child) return
      if (child instanceof WindowsCommandProcess) {
        await child.native.stop()
        return
      }
      await new Promise<void>((resolve) => {
        child.once('close', () => resolve())
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      })
    })()
    return this.closing
  }
}
