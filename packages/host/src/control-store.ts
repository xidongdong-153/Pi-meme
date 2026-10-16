import { createHash, randomUUID } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  AppProject,
  AppSession,
  EventPage,
  EventSubscription,
  HostControlEvent,
  SubmissionReceipt,
} from '@pi-meme/contracts/app-host'

type Operation = {
  operationId: string
  input: string
  status: 'pending' | 'completed' | 'failed' | 'interrupted'
  result?: unknown
  error?: string
}
type State = {
  version: 2
  journalEpoch: string
  seq: number
  projects: AppProject[]
  sessions: AppSession[]
  operations: Record<string, Operation>
  receipts: SubmissionReceipt[]
  events: HostControlEvent[]
}
export class ControlError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
  }
}
export function matchesControlEvent(event: HostControlEvent, input: EventSubscription) {
  return (
    (!input.projectId || event.projectId === input.projectId) &&
    (!input.sessionId || event.sessionId === input.sessionId) &&
    (!input.terminalId || ('terminalId' in event.value && event.value.terminalId === input.terminalId))
  )
}

export class ControlStore {
  readonly state: State = {
    version: 2,
    journalEpoch: randomUUID(),
    seq: 0,
    projects: [],
    sessions: [],
    operations: {},
    receipts: [],
    events: [],
  }
  private saving: Promise<void> = Promise.resolve()
  private readonly running = new Map<string, Promise<unknown>>()
  private readonly listeners = new Set<{ input: EventSubscription; callback: (event: HostControlEvent) => void }>()
  constructor(
    private readonly root: string,
    private readonly hostId: string,
    private readonly capacity = 4096,
  ) {}
  async init() {
    try {
      const saved: State = JSON.parse(await readFile(path.join(this.root, 'control.json'), 'utf8'))
      if (saved.version !== 2 || !Array.isArray(saved.events) || !Array.isArray(saved.sessions) || !saved.operations)
        throw new Error('控制日志格式无效')
      Object.assign(this.state, saved)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    }
    for (const operation of Object.values(this.state.operations)) {
      if (operation.status === 'pending') {
        operation.status = 'interrupted'
        operation.error = 'Host 已重启，操作中断；不会重新执行'
      }
    }
    for (const session of this.state.sessions) {
      if (session.status === 'running') session.status = 'interrupted'
    }
    for (const receipt of this.state.receipts) {
      if (['accepted', 'queued', 'running'].includes(receipt.status)) {
        receipt.status = 'interrupted'
        receipt.error = 'Host 已重启，提交中断；不会重新执行'
        receipt.outcomeUncertain = Boolean(receipt.dispatchStartedAt)
        const operation = Object.values(this.state.operations).find((item) => item.operationId === receipt.operationId)
        if (operation) operation.result = receipt
        await this.publish({ type: 'submission', sessionId: receipt.session.sessionId, value: receipt })
      }
    }
    await this.save()
  }
  save() {
    const data = JSON.stringify(this.state)
    const pending = this.saving
      .catch(() => {})
      .then(async () => {
        const file = path.join(this.root, 'control.json')
        await writeFile(`${file}.tmp`, data, { mode: 0o600 })
        await rename(`${file}.tmp`, file)
      })
    this.saving = pending
    return pending
  }
  async mutate<T>(
    clientId: string,
    key: string,
    method: string,
    args: unknown[],
    action: (operationId: string) => Promise<T>,
  ): Promise<T> {
    if (typeof key !== 'string' || !key || key.length > 128)
      throw new ControlError('invalid-key', '写操作必须传入 1 到 128 字符的幂等键')
    const id = JSON.stringify([clientId, key])
    const input = createHash('sha256')
      .update(JSON.stringify([method, args]))
      .digest('hex')
    const previous = this.state.operations[id]
    if (previous) {
      if (previous.input !== input) throw new ControlError('idempotency-conflict', '幂等键已经用于不同内容')
      if (this.running.has(id)) return this.running.get(id) as Promise<T>
      if (previous.status === 'completed') return structuredClone(previous.result) as T
      if (
        previous.status === 'interrupted' &&
        this.state.receipts.some((item) => item.operationId === previous.operationId)
      )
        return structuredClone(this.state.receipts.find((item) => item.operationId === previous.operationId)) as T
      throw new ControlError(previous.status, previous.error ?? '操作已经中断，不会重新执行')
    }
    const operation: Operation = { operationId: randomUUID(), input, status: 'pending' }
    this.state.operations[id] = operation
    const pending = (async () => {
      try {
        await this.save()
        const result = await action(operation.operationId)
        operation.result = result
        operation.status = 'completed'
        await this.save()
        return structuredClone(result)
      } catch (cause) {
        operation.status = 'failed'
        operation.error = cause instanceof Error ? cause.message : String(cause)
        await this.save().catch(() => {})
        throw cause
      }
    })()
    this.running.set(id, pending)
    try {
      return await pending
    } finally {
      this.running.delete(id)
    }
  }
  async publish(
    input: Pick<HostControlEvent, 'type' | 'value'> & Partial<Pick<HostControlEvent, 'sessionId' | 'projectId'>>,
  ) {
    const event: HostControlEvent = {
      ...input,
      value: structuredClone(input.value),
      hostId: this.hostId,
      journalEpoch: this.state.journalEpoch,
      seq: ++this.state.seq,
      eventId: randomUUID(),
      timestamp: new Date().toISOString(),
    }
    this.state.events.push(event)
    if (this.state.events.length > this.capacity) this.state.events.splice(0, this.state.events.length - this.capacity)
    await this.save()
    for (const listener of this.listeners) {
      if (matchesControlEvent(event, listener.input)) {
        try {
          listener.callback(event)
        } catch {
          /* 单个订阅者不能中断已保存的事件。 */
        }
      }
    }
    return event
  }
  publishLive(
    input: Pick<HostControlEvent, 'type' | 'value'> & Partial<Pick<HostControlEvent, 'sessionId' | 'projectId'>>,
  ) {
    const event: HostControlEvent = {
      ...input,
      stream: 'live',
      value: structuredClone(input.value),
      hostId: this.hostId,
      journalEpoch: this.state.journalEpoch,
      seq: this.state.seq,
      eventId: randomUUID(),
      timestamp: new Date().toISOString(),
    }
    for (const listener of this.listeners)
      if (matchesControlEvent(event, listener.input)) {
        try {
          listener.callback(event)
        } catch {
          /* 单个订阅者不能中断已保存的事件。 */
        }
      }
  }
  read(input: EventSubscription = {}): EventPage {
    if (
      !input ||
      typeof input !== 'object' ||
      ['projectId', 'sessionId', 'terminalId'].some((key) => {
        const value = input[key as keyof EventSubscription]
        return value !== undefined && (typeof value !== 'string' || !value || value.length > 128)
      }) ||
      (input.after &&
        (typeof input.after.journalEpoch !== 'string' || !Number.isSafeInteger(input.after.seq) || input.after.seq < 0))
    )
      throw new Error('事件订阅参数无效')
    const cursor = { journalEpoch: this.state.journalEpoch, seq: this.state.seq }
    const resyncRequired = Boolean(
      input.after &&
      (input.after.journalEpoch !== cursor.journalEpoch ||
        input.after.seq > cursor.seq ||
        input.after.seq < (this.state.events[0]?.seq ?? cursor.seq + 1) - 1),
    )
    return {
      cursor,
      resyncRequired,
      events: resyncRequired
        ? []
        : this.state.events.filter((event) => event.seq > (input.after?.seq ?? 0) && matchesControlEvent(event, input)),
    }
  }
  subscribe(input: EventSubscription, callback: (event: HostControlEvent) => void) {
    const page = this.read(input)
    const listener = { input, callback }
    this.listeners.add(listener)
    if (page.resyncRequired) {
      callback({
        ...page.cursor,
        eventId: randomUUID(),
        hostId: this.hostId,
        timestamp: new Date().toISOString(),
        type: 'resync',
        value: { reason: '事件游标已失效，请重新读取目标快照' },
      })
    } else for (const event of page.events) callback(event)
    return () => {
      this.listeners.delete(listener)
    }
  }
  assertIdle() {
    if (this.running.size) throw new Error('仍有未完成的控制操作，请稍后再维护存储')
  }
  async flush() {
    await this.saving
  }
}
