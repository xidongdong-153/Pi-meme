import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { HostApi, HostControlEvent, SessionRef } from '@pi-meme/contracts/app-host'
import {
  isLiveServiceActivity,
  type ServiceActivity,
  type ServiceActivityLogs,
} from '@pi-meme/contracts/service-activity'

export type ActivityState = {
  activities: ServiceActivity[]
  known: boolean
  loading: boolean
  connected: boolean
  error: string
  stopping: string[]
  errors: Record<string, string>
  logs: Record<string, ServiceActivityLogs>
  logErrors: Record<string, string>
  logsLoading: string[]
}
function keyOf(ref: SessionRef) {
  return JSON.stringify([ref.hostId, ref.sessionId])
}
function emptyState(): ActivityState {
  return {
    activities: [],
    known: false,
    loading: false,
    connected: true,
    error: '',
    stopping: [],
    errors: {},
    logs: {},
    logErrors: {},
    logsLoading: [],
  }
}

export class ActivityStore {
  private readonly states = new Map<string, ActivityState>()
  private readonly listeners = new Set<() => void>()
  private readonly expanded = new Set<string>()
  private generation = 0
  private current?: SessionRef
  private release?: () => void
  private online = true
  private subscribing = false
  private readonly pendingLogs = new Map<string, Promise<void>>()
  private readonly logsAgain = new Set<string>()
  private refreshPending?: Promise<void>
  private refreshAgain = false

  constructor(readonly host: HostApi) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  state(ref?: SessionRef): ActivityState {
    const key = ref ? keyOf(ref) : ''
    let state = this.states.get(key)
    if (!state) {
      state = emptyState()
      this.states.set(key, state)
      if (this.states.size > 20) {
        const oldest = [...this.states.keys()].find(
          (entry) => entry !== key && entry !== (this.current ? keyOf(this.current) : ''),
        )
        if (oldest !== undefined) this.states.delete(oldest)
      }
    }
    return state
  }

  private update(ref: SessionRef, update: Partial<ActivityState>) {
    this.states.set(keyOf(ref), { ...this.state(ref), ...update })
    for (const listener of this.listeners) listener()
  }

  watch(ref: SessionRef) {
    this.release?.()
    this.release = undefined
    this.current = ref
    this.expanded.clear()
    const generation = ++this.generation
    this.subscribing = true
    const valid = () => generation === this.generation
    this.refreshPending = undefined
    this.refreshAgain = false
    this.update(ref, { loading: true, connected: this.online })
    void this.host.activities
      .list(ref)
      .then((result) => {
        if (valid()) {
          this.online = true
          this.update(ref, { activities: result.activities, known: true, loading: false, connected: true, error: '' })
        }
        return result
      })
      .catch((cause) => {
        if (valid()) this.update(ref, { loading: false, error: String(cause) })
        return undefined
      })
      .then(async (result) => {
        if (!valid()) return
        const release = await this.host.events.subscribe(
          { sessionId: ref.sessionId, after: result?.cursor },
          (event) => {
            if (valid()) this.receive(ref, event)
          },
        )
        if (valid()) {
          this.release = release
          this.subscribing = false
        } else release()
      })
      .catch((cause) => {
        if (valid()) {
          this.subscribing = false
          this.update(ref, { loading: false, error: String(cause) })
        }
      })
    return () => {
      if (!valid()) return
      this.generation++
      this.release?.()
      this.release = undefined
      this.current = undefined
      this.expanded.clear()
    }
  }

  setConnected(connected: boolean) {
    const changed = this.online !== connected
    this.online = connected
    if (!this.current) return
    this.update(this.current, { connected })
    if (changed && connected) void this.refresh(this.current)
  }

  private receive(ref: SessionRef, event: HostControlEvent) {
    if (event.hostId !== ref.hostId || (event.sessionId && event.sessionId !== ref.sessionId)) return
    if (event.type === 'resync') {
      const reason = (event.value as { reason?: string }).reason
      if (reason === 'disconnected') {
        this.setConnected(false)
      } else if (!this.online) {
        this.setConnected(true)
      } else {
        void this.refresh(ref)
      }
      return
    }
    if (event.type !== 'activity') return
    const value = event.value as Partial<ServiceActivity> & { logSequence?: number }
    if (typeof value.logSequence === 'number') {
      if (value.serviceId && this.expanded.has(value.serviceId)) void this.loadLogs(ref, value.serviceId)
      return
    }
    void this.refresh(ref)
  }

  async refresh(ref: SessionRef) {
    if (!this.current || keyOf(this.current) !== keyOf(ref)) return
    if (!this.release && !this.subscribing) {
      this.watch(ref)
      return
    }
    if (this.refreshPending) {
      this.refreshAgain = true
      return this.refreshPending
    }
    const generation = this.generation
    const valid = () => generation === this.generation
    this.update(ref, { loading: true })
    const pending = this.host.activities
      .list(ref)
      .then((result) => {
        if (!valid()) return
        const latest = this.state(ref).activities
        const activities = result.activities.map((item) => {
          const newer = latest.find((entry) => entry.serviceId === item.serviceId && entry.revision > item.revision)
          return newer ?? item
        })
        this.online = true
        this.update(ref, { activities, known: true, connected: true, error: '' })
        for (const id of this.expanded) void this.loadLogs(ref, id)
      })
      .catch((cause) => {
        if (valid()) this.update(ref, { error: String(cause) })
      })
      .finally(() => {
        if (!valid()) return
        this.refreshPending = undefined
        this.update(ref, { loading: false })
        if (this.refreshAgain) {
          this.refreshAgain = false
          void this.refresh(ref)
        }
      })
    this.refreshPending = pending
    return pending
  }

  async stop(ref: SessionRef, serviceId: string) {
    const state = this.state(ref)
    if (!state.connected || state.stopping.includes(serviceId)) return
    this.update(ref, { stopping: [...state.stopping, serviceId], errors: { ...state.errors, [serviceId]: '' } })
    try {
      const result = await this.host.activities.stop(ref, serviceId, { idempotencyKey: crypto.randomUUID() })
      const current = this.state(ref)
      this.update(ref, {
        activities: current.activities.map((item) =>
          item.serviceId === serviceId && result.revision >= item.revision ? result : item,
        ),
      })
    } catch (cause) {
      this.update(ref, { errors: { ...this.state(ref).errors, [serviceId]: String(cause) } })
    } finally {
      this.update(ref, { stopping: this.state(ref).stopping.filter((id) => id !== serviceId) })
    }
  }

  expandLogs(ref: SessionRef, serviceId: string, open: boolean) {
    if (open) {
      this.expanded.add(serviceId)
      if (this.state(ref).connected) void this.loadLogs(ref, serviceId)
    } else this.expanded.delete(serviceId)
  }

  async loadLogs(ref: SessionRef, serviceId: string) {
    const key = `${keyOf(ref)}:${serviceId}`
    if (this.pendingLogs.has(key)) {
      this.logsAgain.add(key)
      return this.pendingLogs.get(key)
    }
    this.update(ref, {
      logsLoading: [...this.state(ref).logsLoading, serviceId],
      logErrors: { ...this.state(ref).logErrors, [serviceId]: '' },
    })
    const pending = this.host.activities
      .logs(ref, serviceId)
      .then((logs) => {
        const previous = this.state(ref).logs[serviceId]
        if (!previous || logs.sequence >= previous.sequence)
          this.update(ref, { logs: { ...this.state(ref).logs, [serviceId]: logs } })
      })
      .catch((cause) => this.update(ref, { logErrors: { ...this.state(ref).logErrors, [serviceId]: String(cause) } }))
      .finally(() => {
        this.pendingLogs.delete(key)
        this.update(ref, { logsLoading: this.state(ref).logsLoading.filter((id) => id !== serviceId) })
        if (
          this.logsAgain.delete(key) &&
          this.current &&
          keyOf(this.current) === keyOf(ref) &&
          this.expanded.has(serviceId)
        )
          void this.loadLogs(ref, serviceId)
      })
    this.pendingLogs.set(key, pending)
    return pending
  }

  dispose() {
    this.generation++
    this.release?.()
    this.release = undefined
    this.current = undefined
    this.listeners.clear()
  }
}

export function useActivities(host: HostApi, ref: SessionRef | undefined) {
  const store = useMemo(() => new ActivityStore(host), [host])
  useEffect(() => () => store.dispose(), [store])
  useEffect(() => (ref ? store.watch(ref) : undefined), [store, ref?.hostId, ref?.sessionId])
  const state = useSyncExternalStore(store.subscribe, () => store.state(ref))
  return { store, state, count: state.activities.filter(isLiveServiceActivity).length }
}
