import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { SshConnection, SshConnectionInput, SshConnectionStep } from '@pi-meme/contracts/ssh-connections'
import { storageLayoutRelativePaths } from '@pi-meme/contracts/storage-paths'
import type { ConnectionCredentialStore } from './connection-credentials'
import { createSshHostPreparer, type SshHostPreparer } from './ssh-host-bootstrap'
import {
  createSshTunnelStarter,
  findSshExecutable,
  SshError,
  type SshTunnel,
  type SshTunnelStarter,
} from './ssh-tunnels'

type Saved = Omit<SshConnection, 'phase' | 'step' | 'error' | 'errorCode' | 'nextRetryAt'>
type Runtime = {
  saved: Saved
  phase: SshConnection['phase']
  step?: SshConnectionStep
  error?: string
  errorCode?: string
  nextRetryAt?: string
  controller?: AbortController
  tunnel?: SshTunnel
  timer?: ReturnType<typeof setTimeout>
  attempt: number
  generation: number
  pending?: Promise<void>
  stopping?: Promise<void>
}
export type SshConnectionOptions = {
  prepare?: SshHostPreparer
  startTunnel?: SshTunnelStarter
  available?: () => Promise<boolean>
  retryDelay?: (attempt: number) => number
}
type Hooks = {
  login: (
    connection: SshConnection,
    endpoint: string,
    signal: AbortSignal,
  ) => Promise<{ hostId: string; cookie: string }>
  changed: (connection: SshConnection, endpoint?: string, cookie?: string) => void
  removed: (id: string) => void
}

function port(value: unknown) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535
}
function input(value: SshConnectionInput) {
  if (!value || typeof value !== 'object') throw new Error('SSH 连接参数无效')
  if (value.name !== undefined && (typeof value.name !== 'string' || value.name.length > 255))
    throw new Error('显示名称不能超过 255 字符')
  if (
    typeof value.target !== 'string' ||
    value.target.length > 255 ||
    value.target.startsWith('-') ||
    !/^(?:[\w.-]+@)?(?:\w[\w.-]*|\[[a-fA-F0-9:]+\]|[a-fA-F0-9]*:[a-fA-F0-9:]+)$/.test(value.target)
  )
    throw new Error('SSH 目标须为主机、user@host 或配置别名，不能包含命令参数')
  if (value.port !== undefined && !port(value.port)) throw new Error('SSH 端口必须是 1 到 65535 的整数')
  if (
    value.identityFile !== undefined &&
    (typeof value.identityFile !== 'string' ||
      value.identityFile.length > 4096 ||
      /[\0\r\n]/.test(value.identityFile) ||
      (!path.isAbsolute(value.identityFile) && !value.identityFile.startsWith('~/')))
  )
    throw new Error('身份文件必须是入口 Host 上的绝对路径或 ~/ 路径')
  return {
    name: value.name?.trim() || value.target,
    target: value.target,
    port: value.port,
    identityFile: value.identityFile,
  }
}

export class SshConnections {
  private readonly states = new Map<string, Runtime>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly stops = new Set<Promise<void>>()
  private mutations = 0
  private stopTunnel(tunnel: SshTunnel) {
    const stopping = tunnel.stop()
    this.stops.add(stopping)
    void stopping.finally(() => this.stops.delete(stopping)).catch(() => {})
    return stopping
  }
  private mutation: Promise<unknown> = Promise.resolve()
  private writing = Promise.resolve()
  private closing = false
  private readonly startTunnel: SshTunnelStarter
  private readonly prepare: SshHostPreparer
  constructor(
    private readonly root: string,
    private readonly credentials: ConnectionCredentialStore,
    private readonly hooks: Hooks,
    private readonly options: SshConnectionOptions = {},
  ) {
    this.startTunnel = options.startTunnel ?? createSshTunnelStarter()
    this.prepare =
      options.prepare ?? createSshHostPreparer({ cacheDirectory: path.join(root, 'cache/ssh-host-packages') })
  }
  async available() {
    return this.options.available ? this.options.available() : Boolean(await findSshExecutable())
  }
  private public(state: Runtime): SshConnection {
    return {
      ...state.saved,
      phase: state.phase,
      step: state.step,
      error: state.error,
      errorCode: state.errorCode,
      nextRetryAt: state.nextRetryAt,
    }
  }
  private emit(state: Runtime, cookie?: string) {
    this.hooks.changed(this.public(state), state.phase === 'connected' ? state.tunnel?.endpoint : undefined, cookie)
  }
  list() {
    return [...this.states.values()].map((state) => this.public(state))
  }
  has(id: string) {
    return this.states.has(id)
  }
  private get(id: string) {
    const state = this.states.get(id)
    if (!state) throw new Error('SSH 连接未登记')
    return state
  }
  endpoint(id: string) {
    const state = this.get(id)
    if (!state.saved.enabled || state.phase !== 'connected' || !state.tunnel || state.controller?.signal.aborted)
      throw new Error(state.phase === 'paused' ? 'SSH 连接已暂停，请先恢复连接' : 'SSH 连接尚未就绪')
    return state.tunnel.endpoint
  }
  private serialize<T>(work: () => Promise<T>) {
    if (this.closing) return Promise.reject(new Error('入口 Host 正在退出'))
    this.mutations++
    const action = this.mutation
      .catch(() => {})
      .then(work)
      .finally(() => {
        this.mutations--
      })
    this.mutation = action
    return action
  }
  async initialize() {
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(path.join(this.root, storageLayoutRelativePaths.sshConnectionsFile), 'utf8'))
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return
      throw new Error('SSH 连接配置无法读取，已保留原文件')
    }
    if (!Array.isArray(raw)) throw new Error('SSH 连接配置格式无效，已保留原文件')
    for (const item of raw as Saved[]) {
      const fields = input(item)
      if (
        !/^[a-f0-9]{24}$/.test(item.id) ||
        this.states.has(item.id) ||
        typeof item.enabled !== 'boolean' ||
        (item.hostId !== undefined && (typeof item.hostId !== 'string' || !item.hostId))
      )
        throw new Error('SSH 连接配置格式无效，已保留原文件')
      const saved: Saved = { ...fields, id: item.id, enabled: item.enabled, hostId: item.hostId }
      const state: Runtime = { saved, phase: 'paused', generation: 0, attempt: 0 }
      this.states.set(saved.id, state)
      this.emit(state)
    }
    for (const state of this.states.values()) if (state.saved.enabled) this.launch(state)
  }
  private persist(identity?: { state: Runtime; hostId: string; current: () => boolean }) {
    this.writing = this.writing
      .catch(() => {})
      .then(async () => {
        if (identity && !identity.current()) return
        const value = JSON.stringify(
          [...this.states.values()].map((state) =>
            state === identity?.state ? { ...state.saved, hostId: identity.hostId } : state.saved,
          ),
          null,
          2,
        )
        const file = path.join(this.root, storageLayoutRelativePaths.sshConnectionsFile)
        await mkdir(path.dirname(file), { recursive: true })
        await writeFile(`${file}.tmp`, `${value}\n`, { mode: 0o600 })
        await rename(`${file}.tmp`, file)
        if (identity?.current()) identity.state.saved = { ...identity.state.saved, hostId: identity.hostId }
      })
    return this.writing
  }
  save(value: SshConnectionInput) {
    return this.serialize(async () => {
      const fields = input(value)
      const old = value.id ? this.get(value.id) : undefined
      if (
        !old &&
        [...this.states.values()].some(
          (state) =>
            state.saved.target === fields.target &&
            state.saved.port === fields.port &&
            state.saved.identityFile === fields.identityFile,
        )
      )
        throw new Error('此 SSH 连接已经添加')
      if (
        old?.saved.enabled &&
        (old.saved.target !== fields.target ||
          old.saved.port !== fields.port ||
          old.saved.identityFile !== fields.identityFile)
      )
        throw new Error('请先暂停 SSH 连接，再修改连接参数')
      const saved: Saved = {
        ...fields,
        id: old?.saved.id ?? randomBytes(12).toString('hex'),
        enabled: old?.saved.enabled ?? true,
        hostId: old?.saved.hostId,
      }
      const state: Runtime = old ?? { saved, phase: 'paused', generation: 0, attempt: 0 }
      const previous = state.saved
      state.saved = saved
      if (!old) this.states.set(saved.id, state)
      try {
        await this.persist()
      } catch (cause) {
        state.saved = previous
        if (!old) this.states.delete(saved.id)
        throw cause
      }
      if (!saved.enabled) state.phase = 'paused'
      if (!old) this.launch(state)
      else this.emit(state)
      return this.public(state)
    })
  }
  setEnabled(id: string, enabled: boolean) {
    return this.serialize(async () => {
      const state = this.get(id)
      if (state.saved.enabled === enabled) return this.public(state)
      const previous = state.saved
      state.saved = { ...previous, enabled }
      try {
        await this.persist()
      } catch (cause) {
        state.saved = previous
        throw cause
      }
      await this.stop(state)
      state.attempt = 0
      if (enabled) this.launch(state)
      else {
        state.phase = 'paused'
        delete state.error
        delete state.errorCode
        this.emit(state)
      }
      return this.public(state)
    })
  }
  retry(id: string) {
    return this.serialize(async () => {
      const state = this.get(id)
      if (!state.saved.enabled) throw new Error('SSH 连接已暂停，请先恢复连接')
      await this.stop(state)
      state.attempt = 0
      this.launch(state)
      return this.public(state)
    })
  }
  remove(id: string) {
    return this.serialize(async () => {
      const state = this.get(id)
      await this.stop(state)
      const token = this.credentials.readSsh(id)
      try {
        await this.credentials.removeSsh(id)
      } catch (cause) {
        if (state.saved.enabled) this.launch(state)
        throw cause
      }
      this.states.delete(id)
      try {
        await this.persist()
      } catch (cause) {
        this.states.set(id, state)
        if (token) await this.credentials.saveSsh(id, token)
        if (state.saved.enabled) this.launch(state)
        this.emit(state)
        throw cause
      }
      this.hooks.removed(id)
    })
  }
  private async stop(state: Runtime) {
    state.generation++
    clearTimeout(state.timer)
    state.timer = undefined
    delete state.nextRetryAt
    delete state.step
    state.controller?.abort()
    state.controller = undefined
    const tunnel = state.tunnel
    state.tunnel = undefined
    state.phase = 'paused'
    this.emit(state)
    if (tunnel) state.stopping = this.stopTunnel(tunnel)
    await state.stopping
    await state.pending
  }
  private launch(state: Runtime) {
    if (this.closing || !state.saved.enabled || this.states.get(state.saved.id) !== state) return
    clearTimeout(state.timer)
    delete state.nextRetryAt
    delete state.error
    delete state.errorCode
    state.phase = 'connecting'
    state.step = 'checking'
    const generation = ++state.generation
    const controller = new AbortController()
    state.controller = controller
    const current = () =>
      !this.closing &&
      !controller.signal.aborted &&
      state.generation === generation &&
      this.states.get(state.saved.id) === state &&
      state.saved.enabled
    this.emit(state)
    const pending = (async () => {
      let tunnel: SshTunnel | undefined
      try {
        await state.stopping
        if (!current()) return
        const prepared = await this.prepare(state.saved, controller.signal, (step) => {
          if (!current()) return
          state.step = step
          this.emit(state)
        })
        if (!current()) return
        if (state.saved.hostId && prepared.hostId !== state.saved.hostId)
          throw new SshError('host-identity', '远程服务身份已变化，请移除连接后重新添加')
        try {
          await this.credentials.saveSsh(state.saved.id, prepared.token)
        } catch {
          throw new SshError('storage', '无法保存 SSH 连接凭据，请检查入口 Host 存储')
        }
        if (!current()) return
        tunnel = await this.startTunnel(state.saved, prepared.port, controller.signal)
        if (!current()) {
          await this.stopTunnel(tunnel)
          return
        }
        state.tunnel = tunnel
        let ended = false
        void tunnel.closed.then((cause) => {
          ended = true
          if (current()) this.failed(state, cause)
        })
        state.step = 'authenticating'
        this.emit(state)
        const result = await this.hooks.login(
          { ...this.public(state), hostId: prepared.hostId },
          tunnel.endpoint,
          controller.signal,
        )
        if (!current() || ended) return
        try {
          await this.persist({ state, hostId: result.hostId, current })
        } catch {
          throw new SshError('storage', '无法保存 SSH 连接身份，请检查入口 Host 存储')
        }
        if (!current() || ended) return
        state.phase = 'connected'
        delete state.step
        state.attempt = 0
        this.emit(state, result.cookie)
      } catch (cause) {
        if (current()) this.failed(state, cause)
        if (tunnel) await this.stopTunnel(tunnel)
      }
    })()
    state.pending = pending
    this.pending.add(pending)
    void pending
      .finally(() => {
        this.pending.delete(pending)
        if (state.pending === pending) state.pending = undefined
      })
      .catch(() => {})
  }
  connectionFailed(id: string, cause: unknown) {
    const state = this.states.get(id)
    if (state?.saved.enabled && state.phase === 'connected') this.failed(state, cause)
  }
  private failed(state: Runtime, cause: unknown) {
    state.generation++
    delete state.step
    state.controller?.abort()
    state.controller = undefined
    const tunnel = state.tunnel
    state.tunnel = undefined
    if (tunnel) state.stopping = this.stopTunnel(tunnel)
    const failure =
      cause instanceof SshError
        ? cause
        : new SshError('host-unavailable', 'SSH 连接准备或远端 Host 访问失败，请检查网络后重试', true)
    state.errorCode = failure.code
    state.error = failure.message
    if (failure.retryable && state.saved.enabled && !this.closing) {
      const wait =
        this.options.retryDelay?.(state.attempt++) ??
        Math.min(1000 * 2 ** Math.min(state.attempt++, 4), 15000) * (0.9 + Math.random() * 0.2)
      state.phase = 'retrying'
      state.nextRetryAt = new Date(Date.now() + wait).toISOString()
      state.timer = setTimeout(() => this.launch(state), wait)
      state.timer.unref()
    } else state.phase = 'action-required'
    this.emit(state)
  }
  assertIdle() {
    if (this.pending.size || this.stops.size || this.mutations) throw new Error('SSH 连接正在处理，请稍后再维护存储')
  }
  dispose() {
    this.closing = true
    for (const state of this.states.values()) {
      const stopped = this.stop(state)
      this.pending.add(stopped)
      void stopped.finally(() => this.pending.delete(stopped)).catch(() => {})
    }
  }
  async flush() {
    await this.mutation.catch(() => {})
    await Promise.allSettled([...this.pending])
    await Promise.allSettled([...this.stops])
    await this.writing
  }
}
