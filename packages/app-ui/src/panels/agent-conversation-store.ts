import type { DesktopBridge, DesktopEvent, Snapshot } from '@pi-meme/contracts/desktop'
import type { AgentSummary } from '@pi-meme/contracts/collaboration'
import { applyEvent, emptyChat, restoreSnapshot } from '@pi-meme/chat/ui/model/state'
import type { ChatState } from '@pi-meme/chat/ui/model/types'

type AgentView = { chat: ChatState; agent?: AgentSummary; loading: boolean; error: string }

export class AgentConversationStore {
  private value: AgentView = { chat: emptyChat, loading: true, error: '' }
  private readonly listeners = new Set<() => void>()
  private pending: DesktopEvent[] = []
  private sequence = 0
  private executionGeneration?: number
  private reading?: Promise<void>
  private closed = false
  private recoveryFingerprint?: string
  private offEvent?: () => void
  private offConnection?: () => void

  constructor(
    private readonly bridge: Pick<DesktopBridge, 'getAgentSnapshot' | 'onEvent' | 'onConnection'>,
    readonly agentId: string,
  ) {}

  getSnapshot = () => this.value
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private publish(next: AgentView) {
    this.value = next
    for (const listener of this.listeners) listener()
  }
  start() {
    this.offEvent = this.bridge.onEvent((record) => this.receive(record))
    this.offConnection = this.bridge.onConnection((connection) => {
      if (connection.status === 'ready' || connection.status === 'idle') void this.refresh()
    })
    return this.refresh()
  }
  private accepts(record: DesktopEvent) {
    return record.agentId === this.agentId || (!!this.value.agent && record.sessionKey === this.value.agent.sessionKey)
  }
  receive(record: DesktopEvent) {
    if (this.closed) return
    if (record.event.type === 'agents_update') {
      const summary = record.event.agents.find((agent) => agent.agentId === this.agentId)
      if (summary && (!this.value.agent || summary.executionGeneration >= this.value.agent.executionGeneration))
        this.publish({ ...this.value, agent: summary })
      if (summary && summary.executionGeneration !== this.executionGeneration) void this.refresh()
      return
    }
    if (!this.accepts(record)) return
    const execution = this.executionGeneration
    if (execution !== undefined && record.executionGeneration !== undefined && record.executionGeneration < execution)
      return
    if (
      this.reading ||
      !this.value.agent ||
      (record.executionGeneration !== undefined && record.executionGeneration !== execution) ||
      (record.sequence !== undefined && record.sequence > this.sequence + 1)
    ) {
      this.pending.push(record)
      void this.refresh()
      return
    }
    this.apply(record)
  }
  private apply(record: DesktopEvent) {
    if (record.sequence !== undefined && record.sequence <= this.sequence) return
    if (record.sequence !== undefined) this.sequence = record.sequence
    const event = record.event
    if (
      event.type === 'extension_ui_request' ||
      event.type === 'extension_ui_timeout' ||
      event.type === 'extension_ui_closed' ||
      event.type === 'access_mode_changed' ||
      event.type === 'agents_update' ||
      event.type === 'agent_mailbox'
    )
      return
    this.publish({ ...this.value, chat: applyEvent(this.value.chat, event) })
  }
  refresh(): Promise<void> {
    if (this.reading) return this.reading
    this.reading = this.bridge
      .getAgentSnapshot(this.agentId)
      .then((snapshot: Snapshot) => {
        if (this.closed) return
        const generation = snapshot.agent?.executionGeneration
        const newer =
          (this.value.agent?.executionGeneration ?? 0) > (generation ?? 0) ||
          this.pending.some(
            (record) =>
              generation !== undefined &&
              record.executionGeneration !== undefined &&
              record.executionGeneration > generation,
          )
        const fingerprint = `${generation}:${snapshot.eventSequence ?? 0}`
        if (this.pending.length && this.recoveryFingerprint === fingerprint) {
          this.publish({ ...this.value, loading: false, error: '子代理快照尚未包含缺失事件，请重新打开此对话。' })
          return
        }
        this.recoveryFingerprint = this.pending.length ? fingerprint : undefined
        if (newer) return
        this.executionGeneration = generation
        this.sequence = snapshot.eventSequence ?? 0
        this.publish({ chat: restoreSnapshot(snapshot, null), agent: snapshot.agent, loading: false, error: '' })
        const records = this.pending
        this.pending = []
        for (const record of records) {
          if (
            record.sessionKey !== snapshot.connection.sessionKey ||
            (record.executionGeneration !== undefined &&
              generation !== undefined &&
              record.executionGeneration !== generation)
          )
            continue
          if (record.sequence !== undefined && record.sequence > this.sequence + 1) this.pending.push(record)
          else this.apply(record)
        }
      })
      .catch((cause) => {
        if (!this.closed) this.publish({ ...this.value, loading: false, error: `无法读取子代理对话：${String(cause)}` })
      })
      .finally(() => {
        this.reading = undefined
        if (!this.closed && this.pending.length && !this.value.error) void this.refresh()
      })
    return this.reading
  }
  close() {
    this.closed = true
    this.offEvent?.()
    this.offConnection?.()
    this.listeners.clear()
    this.pending = []
  }
}
