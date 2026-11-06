import type { SettingsBridge } from '@pi-meme/contracts/desktop'
import type { AppearanceOperation, AppearanceSettings, SettingsSnapshot } from '@pi-meme/contracts/settings'
import { migrateAppearance } from '../shared/appearance'
import {
  applyAppearanceOperation,
  canRebaseAppearanceOperation,
  canonicalAppearance,
} from '../shared/appearance-update'

export type AppearanceSaveStatus = 'loading' | 'idle' | 'pending' | 'saved' | 'failed' | 'conflict'
export type AppearanceSaveState = {
  confirmed: SettingsSnapshot | null
  snapshot: SettingsSnapshot | null
  status: AppearanceSaveStatus
  error: string
  pending: number
  frozen: boolean
}
type Intent = { operation: AppearanceOperation; base: AppearanceSettings; rebased: boolean }
type AppearanceBridge = Pick<SettingsBridge, 'getSettings' | 'reloadSettings' | 'saveAppearance'>
const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))
function equal(left: AppearanceSettings, right: AppearanceSettings) {
  return canonicalAppearance(left) === canonicalAppearance(right)
}

/** One window owns one intent queue. Reads never drain or replace pending edits. */
export class AppearanceSaver {
  private confirmed: SettingsSnapshot | null = null
  private intents: Intent[] = []
  private listeners = new Set<() => void>()
  private running: Promise<void> | undefined
  private controller: AbortController | undefined
  private readGeneration = 0
  private writeGeneration = 0
  private status: AppearanceSaveStatus = 'loading'
  private error = ''
  private frozen = false
  private disposed = false
  private state: AppearanceSaveState = {
    confirmed: null,
    snapshot: null,
    status: 'loading',
    error: '',
    pending: 0,
    frozen: false,
  }
  constructor(private bridge: AppearanceBridge) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  getSnapshot = () => this.state
  activate() {
    this.disposed = false
  }
  private appearance(snapshot = this.confirmed) {
    if (!snapshot) throw new Error('外观设置尚未读取')
    return migrateAppearance(snapshot.settings, snapshot.themes)
  }
  private establishesAuthority(operation: AppearanceOperation) {
    return operation.type === 'reset' && this.confirmed?.legacyAppearanceImport === 'eligible'
  }
  private publish() {
    let snapshot = this.confirmed
    if (snapshot) {
      let appearance = this.appearance(snapshot)
      for (const intent of this.intents) {
        try {
          appearance = applyAppearanceOperation(appearance, intent.operation, snapshot.themes)
        } catch (cause) {
          this.status = 'failed'
          this.error = `外观修改暂不可应用：${message(cause)}`
          if (this.state.snapshot) appearance = this.appearance(this.state.snapshot)
          break
        }
      }
      snapshot = { ...snapshot, settings: { ...snapshot.settings, appearance } }
    }
    this.state = {
      confirmed: this.confirmed,
      snapshot,
      status: this.status,
      error: this.error,
      pending: this.intents.length,
      frozen: this.frozen,
    }
    for (const listener of this.listeners) listener()
  }
  async refresh(reload = false) {
    const read = ++this.readGeneration
    const writes = this.writeGeneration
    try {
      const next = await (reload ? this.bridge.reloadSettings() : this.bridge.getSettings())
      if (this.disposed || read !== this.readGeneration || writes !== this.writeGeneration || this.running) return
      this.confirmed = next
      if (!this.intents.length) {
        this.status = this.status === 'saved' ? 'saved' : 'idle'
        this.error = !next.appearanceRevision
          ? '当前 Host 不支持受控外观保存，请更新服务'
          : next.writeState?.status === 'blocked'
            ? (next.writeState.error ?? '配置受保护，暂不能保存')
            : ''
      }
      this.publish()
    } catch (cause) {
      if (this.disposed || read !== this.readGeneration) return
      if (!this.intents.length) this.status = 'failed'
      if (!this.error) this.error = `读取外观失败：${message(cause)}`
      this.publish()
    }
  }
  receive(next: SettingsSnapshot) {
    if (this.disposed || this.running) return
    this.readGeneration++
    this.confirmed = next
    if (!this.intents.length) {
      this.status = 'idle'
      this.error = ''
    }
    this.publish()
  }
  setFrozen(value: boolean) {
    this.frozen = value
    this.publish()
  }
  schedule(operation: AppearanceOperation) {
    if (this.frozen) return
    if (!this.confirmed?.appearanceRevision) throw new Error('当前 Host 不支持受控外观保存，请更新服务')
    if (this.confirmed.writeState?.status === 'blocked')
      throw new Error(this.confirmed.writeState.error ?? '配置受保护，暂不能保存')
    const base = this.appearance(this.state.snapshot)
    const next = applyAppearanceOperation(base, operation, this.confirmed.themes)
    if (equal(base, next) && !this.establishesAuthority(operation)) return
    this.intents.push({ operation: structuredClone(operation), base, rebased: false })
    if (this.status !== 'failed' && this.status !== 'conflict') {
      this.status = 'pending'
      this.error = ''
    }
    this.publish()
    if (this.status === 'pending') void this.flush().catch(() => {})
  }
  flush(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (this.status === 'failed' || this.status === 'conflict')
      return Promise.reject(new Error(this.error || '外观尚未保存'))
    if (!this.intents.length && !this.running) return Promise.resolve()
    if (!this.running) {
      this.running = this.drain().finally(() => {
        this.running = undefined
        if (!this.disposed) void this.refresh()
      })
    }
    const abort = () => this.controller?.abort(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    return this.running.finally(() => signal?.removeEventListener('abort', abort))
  }
  private async drain() {
    try {
      while (this.intents.length) {
        const intent = this.intents[0]!
        const current = this.appearance()
        const next = applyAppearanceOperation(current, intent.operation, this.confirmed!.themes)
        // A lost reply can leave an already committed intent in the queue.
        if (equal(current, next) && !this.establishesAuthority(intent.operation)) {
          this.intents.shift()
          this.publish()
          continue
        }
        if (!canRebaseAppearanceOperation(intent.operation, intent.base, current)) {
          this.status = 'conflict'
          throw new Error('外观已被其他操作修改，请采用最新值或重试我的修改')
        }
        this.controller = new AbortController()
        this.writeGeneration++
        const result = await this.bridge.saveAppearance(
          {
            expectedRevision: this.confirmed!.appearanceRevision,
            operation: intent.operation,
          },
          this.controller.signal,
        )
        this.controller = undefined
        this.confirmed = result.snapshot
        if (result.status === 'conflict') {
          if (!intent.rebased && canRebaseAppearanceOperation(intent.operation, intent.base, this.appearance())) {
            intent.rebased = true
            this.publish()
            continue
          }
          this.status = 'conflict'
          throw new Error('外观已被其他操作修改，请采用最新值或重试我的修改')
        }
        this.intents.shift()
        this.publish()
      }
      this.status = 'saved'
      this.error = ''
      this.publish()
    } catch (cause) {
      this.controller = undefined
      if (this.status !== 'conflict') this.status = 'failed'
      this.error = this.status === 'conflict' ? message(cause) : `外观保存尚未确认：${message(cause)}`
      this.publish()
      throw cause
    }
  }
  async retry(signal?: AbortSignal) {
    if (this.running || (this.frozen && !signal)) return
    signal?.throwIfAborted()
    const conflict = this.status === 'conflict'
    await this.refresh()
    signal?.throwIfAborted()
    if (!this.intents.length) return
    if (conflict && !signal) this.intents[0]!.base = this.appearance()
    this.intents[0]!.rebased = false
    this.status = 'pending'
    this.error = ''
    this.publish()
    await this.flush(signal)
  }
  adoptLatest() {
    if (this.running || this.frozen) return
    this.intents.shift()
    this.status = this.intents.length ? 'pending' : 'idle'
    this.error = ''
    this.publish()
    if (this.intents.length) void this.flush().catch(() => {})
  }
  dispose() {
    this.disposed = true
    this.readGeneration++
    this.controller?.abort(new Error('外观所有者已卸载'))
    this.listeners.clear()
  }
}
