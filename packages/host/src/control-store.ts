import { createHash, randomUUID } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import path from 'node:path'
import type {
  AppProject,
  AppSession,
  EventPage,
  EventSubscription,
  HostControlEvent,
  SubmissionReceipt,
} from '@pi-meme/contracts/app-host'

export type Operation = {
  operationId: string
  input: string
  status: 'pending' | 'completed' | 'failed' | 'interrupted'
  result?: unknown
  error?: string
}

export type OperationEntry = {
  id: string // JSON.stringify([clientId, key])
  operationId: string
  input: string
  status: 'pending' | 'completed' | 'failed' | 'interrupted'
  result?: unknown
  error?: string
  timestamp: string
}

export type ControlJournalMutation =
  | { kind: 'project_upsert'; project: AppProject }
  | { kind: 'session_upsert'; session: AppSession }
  | { kind: 'session_delete'; sessionId: string }
  | { kind: 'receipt_upsert'; receipt: SubmissionReceipt }
  | { kind: 'session_receipt_upsert'; session: AppSession; receipt: SubmissionReceipt }

export type ControlJournalEntry = {
  commitSeq: number
  journalEpoch: string
  timestamp: string
  event?: HostControlEvent
  mutation?: ControlJournalMutation
}

export type ControlSnapshot = {
  version: 2
  journalEpoch: string
  appliedCommitSeq: number
  seq: number
  projects: AppProject[]
  sessions: AppSession[]
  receipts: SubmissionReceipt[]
}

export type ControlStorePaths = {
  controlDirectory: string
  controlSnapshotFile: string
  controlEventsFile: string
  controlOperationsFile: string
}

export function createControlStorePaths(controlDirectory: string): ControlStorePaths {
  return {
    controlDirectory,
    controlSnapshotFile: path.join(controlDirectory, 'snapshot.json'),
    controlEventsFile: path.join(controlDirectory, 'events.jsonl'),
    controlOperationsFile: path.join(controlDirectory, 'operations.jsonl'),
  }
}

/** 循环写入 Buffer 直到全部消费完毕，随后调用 handle.sync() 刷盘，杜绝短写 */
async function writeFull(handle: FileHandle, data: string | Buffer): Promise<void> {
  const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  let offset = 0
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset)
    if (bytesWritten === 0) throw new Error('写入文件返回 0 字节')
    offset += bytesWritten
  }
  await handle.sync()
}

/** 在原子替换或文件初建后同步父目录元数据，保障掉电安全 */
async function syncDirectory(dirPath: string): Promise<void> {
  try {
    const handle = await open(dirPath, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    /* 某些非 POSIX 文件系统不支持打开目录执行 sync，平滑忽略 */
  }
}

export function validateOperationEntry(entry: unknown): asserts entry is OperationEntry {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('操作日志条目必须是对象')
  const item = entry as Partial<OperationEntry>
  if (typeof item.id !== 'string' || !item.id) throw new Error('操作条目缺少有效 id')
  if (typeof item.operationId !== 'string' || !item.operationId) throw new Error('操作条目缺少有效 operationId')
  if (typeof item.input !== 'string') throw new Error('操作条目缺少有效 input')
  if (!['pending', 'completed', 'failed', 'interrupted'].includes(item.status as string)) {
    throw new Error(`操作条目状态无效: ${String(item.status)}`)
  }
}

export function validateJournalEntry(entry: unknown): asserts entry is ControlJournalEntry {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('日志条目必须是对象')
  const item = entry as Partial<ControlJournalEntry>
  if (!Number.isSafeInteger(item.commitSeq) || (item.commitSeq as number) < 1)
    throw new Error('日志条目 commitSeq 无效')
  if (typeof item.journalEpoch !== 'string' || !item.journalEpoch) throw new Error('日志条目缺少有效 journalEpoch')
  if (typeof item.timestamp !== 'string') throw new Error('日志条目缺少有效 timestamp')
  if (item.event !== undefined) {
    if (
      !item.event ||
      typeof item.event !== 'object' ||
      typeof item.event.seq !== 'number' ||
      typeof item.event.type !== 'string'
    ) {
      throw new Error('日志条目中的 event 格式无效')
    }
  }
  if (item.mutation !== undefined) {
    if (!item.mutation || typeof item.mutation !== 'object' || typeof item.mutation.kind !== 'string') {
      throw new Error('日志条目中的 mutation 格式无效')
    }
  }
}

export function validateControlSnapshotData(snap: unknown): asserts snap is ControlSnapshot {
  if (!snap || typeof snap !== 'object' || Array.isArray(snap)) throw new Error('控制快照必须是对象')
  const item = snap as Partial<ControlSnapshot>
  if (
    item.version !== 2 ||
    typeof item.journalEpoch !== 'string' ||
    !item.journalEpoch ||
    !Number.isSafeInteger(item.appliedCommitSeq) ||
    (item.appliedCommitSeq as number) < 0 ||
    !Number.isSafeInteger(item.seq) ||
    (item.seq as number) < 0 ||
    !Array.isArray(item.projects) ||
    !Array.isArray(item.sessions) ||
    !Array.isArray(item.receipts)
  ) {
    throw new Error('控制快照格式无效或版本不匹配')
  }
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

/** 一次性将旧版单个 control.json 状态导入至规范目录（仅供升级迁移显式调用） */
export async function importLegacyControlState(
  paths: ControlStorePaths,
  legacyState: {
    version: 2
    journalEpoch: string
    seq: number
    projects: AppProject[]
    sessions: AppSession[]
    operations: Record<string, Operation>
    receipts: SubmissionReceipt[]
    events: HostControlEvent[]
  },
): Promise<void> {
  await mkdir(paths.controlDirectory, { recursive: true })
  await syncDirectory(paths.controlDirectory)

  // 1. 写入 snapshot.json
  const snapshot: ControlSnapshot = {
    version: 2,
    journalEpoch: legacyState.journalEpoch,
    appliedCommitSeq: legacyState.events.length,
    seq: legacyState.seq,
    projects: legacyState.projects,
    sessions: legacyState.sessions,
    receipts: legacyState.receipts,
  }
  const snapTmp = `${paths.controlSnapshotFile}.tmp`
  const snapHandle = await open(snapTmp, 'w', 0o600)
  try {
    await writeFull(snapHandle, JSON.stringify(snapshot, null, 2))
  } finally {
    await snapHandle.close()
  }
  await rename(snapTmp, paths.controlSnapshotFile)
  await syncDirectory(paths.controlDirectory)

  // 2. 写入 events.jsonl
  let commitSeq = 0
  const eventLines: string[] = []
  for (const event of legacyState.events) {
    commitSeq++
    const entry: ControlJournalEntry = {
      commitSeq,
      journalEpoch: legacyState.journalEpoch,
      timestamp: event.timestamp || new Date().toISOString(),
      event,
    }
    eventLines.push(JSON.stringify(entry))
  }
  const eventsTmp = `${paths.controlEventsFile}.tmp`
  const eventsHandle = await open(eventsTmp, 'w', 0o600)
  try {
    if (eventLines.length) {
      await writeFull(eventsHandle, `${eventLines.join('\n')}\n`)
    }
  } finally {
    await eventsHandle.close()
  }
  await rename(eventsTmp, paths.controlEventsFile)
  await syncDirectory(paths.controlDirectory)

  // 3. 写入 operations.jsonl
  const opLines: string[] = []
  for (const [id, op] of Object.entries(legacyState.operations)) {
    const entry: OperationEntry = {
      id,
      operationId: op.operationId,
      input: op.input,
      status: op.status,
      result: op.result,
      error: op.error,
      timestamp: new Date().toISOString(),
    }
    opLines.push(JSON.stringify(entry))
  }
  const opTmp = `${paths.controlOperationsFile}.tmp`
  const opHandle = await open(opTmp, 'w', 0o600)
  try {
    if (opLines.length) {
      await writeFull(opHandle, `${opLines.join('\n')}\n`)
    }
  } finally {
    await opHandle.close()
  }
  await rename(opTmp, paths.controlOperationsFile)
  await syncDirectory(paths.controlDirectory)
}

export class ControlStore {
  // 私有已提交实体视图，只由成功提交的 journal mutation 驱动更新，快照仅从此捕获
  private readonly committedProjects = new Map<string, AppProject>()
  private readonly committedSessions = new Map<string, AppSession>()
  private readonly committedReceipts = new Map<string, SubmissionReceipt>()

  readonly state: {
    version: 2
    journalEpoch: string
    appliedCommitSeq: number
    commitSeq: number
    seq: number
    projects: AppProject[]
    sessions: AppSession[]
    operations: Record<string, Operation>
    receipts: SubmissionReceipt[]
    events: HostControlEvent[]
  } = {
    version: 2,
    journalEpoch: randomUUID(),
    appliedCommitSeq: 0,
    commitSeq: 0,
    seq: 0,
    projects: [],
    sessions: [],
    operations: {},
    receipts: [],
    events: [],
  }

  private queue: Promise<void> = Promise.resolve()
  private readonly running = new Map<string, Promise<unknown>>()
  private readonly listeners = new Set<{ input: EventSubscription; callback: (event: HostControlEvent) => void }>()
  private poisoned = false
  private poisonError?: Error

  constructor(
    readonly paths: ControlStorePaths,
    private readonly hostId: string,
    private readonly capacity = 4096,
  ) {}

  private runQueued<T>(action: () => Promise<T>): Promise<T> {
    if (this.poisoned) {
      return Promise.reject(new ControlError('store-poisoned', this.poisonError?.message ?? '存储已锁定'))
    }
    const pending = this.queue
      .then(async () => {
        if (this.poisoned) throw this.poisonError
        return action()
      })
      .catch((cause) => {
        this.poisoned = true
        this.poisonError = cause instanceof Error ? cause : new Error(String(cause))
        throw cause
      })
    this.queue = pending.then(
      () => {},
      () => {},
    )
    return pending
  }

  async init() {
    await mkdir(this.paths.controlDirectory, { recursive: true })
    await syncDirectory(this.paths.controlDirectory)

    // 1. 读取 snapshot.json（纯规范新路径，拒绝未知结构或版本）
    try {
      const snapContent = await readFile(this.paths.controlSnapshotFile, 'utf8')
      const snap: ControlSnapshot = JSON.parse(snapContent)
      if (
        snap.version !== 2 ||
        typeof snap.journalEpoch !== 'string' ||
        !snap.journalEpoch ||
        !Number.isSafeInteger(snap.appliedCommitSeq) ||
        snap.appliedCommitSeq < 0 ||
        !Number.isSafeInteger(snap.seq) ||
        snap.seq < 0 ||
        !Array.isArray(snap.projects) ||
        !Array.isArray(snap.sessions) ||
        !Array.isArray(snap.receipts)
      ) {
        throw new Error('控制快照格式无效或版本不匹配')
      }
      this.state.journalEpoch = snap.journalEpoch
      this.state.appliedCommitSeq = snap.appliedCommitSeq
      this.state.commitSeq = snap.appliedCommitSeq
      this.state.seq = snap.seq

      for (const p of snap.projects) this.committedProjects.set(p.projectId, structuredClone(p))
      for (const s of snap.sessions) this.committedSessions.set(s.sessionId, structuredClone(s))
      for (const r of snap.receipts) this.committedReceipts.set(r.operationId, structuredClone(r))

      this.syncAllPublicState()
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    }

    // 2. 读取 operations.jsonl
    try {
      const rawContent = await readFile(this.paths.controlOperationsFile)
      const text = rawContent.toString('utf8')
      const hasTrailingNewline = text.endsWith('\n')
      const lines = text.split('\n')
      const completeLines = hasTrailingNewline ? lines.slice(0, -1) : lines.slice(0, -1)
      const incompleteTail = hasTrailingNewline ? '' : (lines[lines.length - 1] ?? '')

      for (let i = 0; i < completeLines.length; i++) {
        const line = completeLines[i]?.trim()
        if (!line) continue
        try {
          const entry = JSON.parse(line)
          validateOperationEntry(entry)
          this.state.operations[entry.id] = {
            operationId: entry.operationId,
            input: entry.input,
            status: entry.status,
            result: entry.result,
            error: entry.error,
          }
        } catch (cause) {
          throw new Error(`操作日志数据损坏（第 ${i + 1} 行）：${String(cause)}`)
        }
      }

      if (incompleteTail.trim()) {
        const validBytes = rawContent.lastIndexOf(0x0a) + 1
        const handle = await open(this.paths.controlOperationsFile, 'r+', 0o600)
        try {
          await handle.truncate(validBytes)
          await handle.sync()
        } finally {
          await handle.close()
        }
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    }

    // 3. 读取 events.jsonl
    try {
      const rawContent = await readFile(this.paths.controlEventsFile)
      const text = rawContent.toString('utf8')
      const hasTrailingNewline = text.endsWith('\n')
      const lines = text.split('\n')
      const completeLines = hasTrailingNewline ? lines.slice(0, -1) : lines.slice(0, -1)
      const incompleteTail = hasTrailingNewline ? '' : (lines[lines.length - 1] ?? '')

      let expectedSeq = -1
      for (let i = 0; i < completeLines.length; i++) {
        const line = completeLines[i]?.trim()
        if (!line) continue
        let entry: ControlJournalEntry
        try {
          entry = JSON.parse(line)
          validateJournalEntry(entry)
        } catch (cause) {
          throw new Error(`事件日志数据损坏（第 ${i + 1} 行）：${String(cause)}`)
        }

        if (entry.journalEpoch !== this.state.journalEpoch) {
          throw new Error(`控制日志 epoch 不匹配：预期 ${this.state.journalEpoch}，实际 ${entry.journalEpoch}`)
        }
        if (entry.event && entry.event.journalEpoch !== this.state.journalEpoch) {
          throw new Error(
            `控制日志事件 epoch 不匹配：预期 ${this.state.journalEpoch}，实际 ${entry.event.journalEpoch}`,
          )
        }

        if (expectedSeq === -1) {
          expectedSeq = entry.commitSeq
          if (entry.commitSeq > this.state.appliedCommitSeq + 1) {
            throw new Error(
              `控制日志断档：起始序号 ${entry.commitSeq} 大于快照应用序号加一 ${this.state.appliedCommitSeq + 1}`,
            )
          }
        } else {
          if (entry.commitSeq !== expectedSeq) {
            throw new Error(`控制日志不连续：预期序号 ${expectedSeq}，实际序号 ${entry.commitSeq}`)
          }
        }
        expectedSeq++

        if (entry.commitSeq <= this.state.appliedCommitSeq) {
          if (entry.event) this.state.events.push(entry.event)
        } else {
          if (entry.mutation) {
            this.applyCommittedMutation(entry.mutation)
          }
          if (entry.event) {
            this.state.events.push(entry.event)
            this.state.seq = Math.max(this.state.seq, entry.event.seq)
          }
          this.state.commitSeq = entry.commitSeq
        }
      }

      if (incompleteTail.trim()) {
        const validBytes = rawContent.lastIndexOf(0x0a) + 1
        const handle = await open(this.paths.controlEventsFile, 'r+', 0o600)
        try {
          await handle.truncate(validBytes)
          await handle.sync()
        } finally {
          await handle.close()
        }
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    }

    if (this.state.events.length > this.capacity) {
      this.state.events.splice(0, this.state.events.length - this.capacity)
    }

    this.syncAllPublicState()

    // 4. 重启恢复处理中断
    for (const [id, operation] of Object.entries(this.state.operations)) {
      if (operation.status === 'pending') {
        operation.status = 'interrupted'
        operation.error = 'Host 已重启，操作中断；不会重新执行'
        await this.appendOperation({
          id,
          operationId: operation.operationId,
          input: operation.input,
          status: 'interrupted',
          error: operation.error,
          timestamp: new Date().toISOString(),
        })
      }
    }

    for (const session of this.committedSessions.values()) {
      if (session.status === 'running') {
        session.status = 'interrupted'
        await this.commitJournal({ mutation: { kind: 'session_upsert', session } })
      }
    }

    for (const receipt of this.committedReceipts.values()) {
      if (['accepted', 'queued', 'running'].includes(receipt.status)) {
        receipt.status = 'interrupted'
        receipt.error = 'Host 已重启，提交中断；不会重新执行'
        receipt.outcomeUncertain = Boolean(receipt.dispatchStartedAt)
        const operation = Object.values(this.state.operations).find((item) => item.operationId === receipt.operationId)
        if (operation) {
          operation.status = 'interrupted'
          operation.result = receipt
          operation.error = receipt.error
          const opId = Object.entries(this.state.operations).find(
            ([, op]) => op.operationId === receipt.operationId,
          )?.[0]
          if (opId) {
            await this.appendOperation({
              id: opId,
              operationId: operation.operationId,
              input: operation.input,
              status: 'interrupted',
              error: operation.error,
              timestamp: new Date().toISOString(),
            })
          }
        }
        await this.publish({ type: 'submission', sessionId: receipt.session.sessionId, value: receipt })
      }
    }

    await this.checkpoint()
  }

  /** 启动初始化时执行一次全量同步 */
  private syncAllPublicState() {
    this.state.projects = [...this.committedProjects.values()].map((p) => structuredClone(p))
    this.state.sessions = [...this.committedSessions.values()].map((s) => structuredClone(s))
    this.state.receipts = [...this.committedReceipts.values()].map((r) => structuredClone(r))
  }

  private applyCommittedMutation(mutation: ControlJournalMutation) {
    switch (mutation.kind) {
      case 'project_upsert': {
        const cloned = structuredClone(mutation.project)
        this.committedProjects.set(mutation.project.projectId, cloned)
        const idx = this.state.projects.findIndex((p) => p.projectId === mutation.project.projectId)
        if (idx >= 0) this.state.projects[idx] = structuredClone(cloned)
        else this.state.projects.push(structuredClone(cloned))
        break
      }
      case 'session_upsert': {
        const cloned = structuredClone(mutation.session)
        this.committedSessions.set(mutation.session.sessionId, cloned)
        const idx = this.state.sessions.findIndex((s) => s.sessionId === mutation.session.sessionId)
        if (idx >= 0) this.state.sessions[idx] = structuredClone(cloned)
        else this.state.sessions.push(structuredClone(cloned))
        break
      }
      case 'session_delete': {
        this.committedSessions.delete(mutation.sessionId)
        const idx = this.state.sessions.findIndex((s) => s.sessionId === mutation.sessionId)
        if (idx >= 0) this.state.sessions.splice(idx, 1)
        break
      }
      case 'receipt_upsert': {
        const cloned = structuredClone(mutation.receipt)
        this.committedReceipts.set(mutation.receipt.operationId, cloned)
        const idx = this.state.receipts.findIndex((r) => r.operationId === mutation.receipt.operationId)
        if (idx >= 0) this.state.receipts[idx] = structuredClone(cloned)
        else this.state.receipts.push(structuredClone(cloned))
        break
      }
      case 'session_receipt_upsert': {
        const clonedSession = structuredClone(mutation.session)
        const clonedReceipt = structuredClone(mutation.receipt)
        this.committedSessions.set(mutation.session.sessionId, clonedSession)
        this.committedReceipts.set(mutation.receipt.operationId, clonedReceipt)
        const sIdx = this.state.sessions.findIndex((s) => s.sessionId === mutation.session.sessionId)
        if (sIdx >= 0) this.state.sessions[sIdx] = structuredClone(clonedSession)
        else this.state.sessions.push(structuredClone(clonedSession))
        const rIdx = this.state.receipts.findIndex((r) => r.operationId === mutation.receipt.operationId)
        if (rIdx >= 0) this.state.receipts[rIdx] = structuredClone(clonedReceipt)
        else this.state.receipts.push(structuredClone(clonedReceipt))
        break
      }
    }
  }

  private appendOperation(entry: OperationEntry): Promise<void> {
    return this.runQueued(async () => {
      const line = `${JSON.stringify(entry)}\n`
      await mkdir(this.paths.controlDirectory, { recursive: true })
      const handle = await open(this.paths.controlOperationsFile, 'a', 0o600)
      try {
        await writeFull(handle, line)
      } finally {
        await handle.close()
      }
    })
  }

  /**
   * 单一内部提交核心入口：在队列临界区内原子分配序号、写入 events.jsonl、更新已提交视图并检查阈值压缩
   */
  private commitJournal(options: {
    mutation?: ControlJournalMutation
    eventInput?: {
      type: HostControlEvent['type']
      value: unknown
      sessionId?: string
      projectId?: string
      eventId: string
      timestamp: string
    }
  }): Promise<{ entry: ControlJournalEntry; event?: HostControlEvent }> {
    return this.runQueued(async () => {
      const commitSeq = ++this.state.commitSeq
      const timestamp = options.eventInput?.timestamp ?? new Date().toISOString()
      let event: HostControlEvent | undefined

      if (options.eventInput) {
        const seq = ++this.state.seq
        event = {
          type: options.eventInput.type,
          value: structuredClone(options.eventInput.value) as HostControlEvent['value'],
          hostId: this.hostId,
          journalEpoch: this.state.journalEpoch,
          seq,
          eventId: options.eventInput.eventId,
          timestamp,
          sessionId: options.eventInput.sessionId,
          projectId: options.eventInput.projectId,
        }
      }

      const entry: ControlJournalEntry = {
        commitSeq,
        journalEpoch: this.state.journalEpoch,
        timestamp,
        event,
        mutation: options.mutation,
      }

      const line = `${JSON.stringify(entry)}\n`
      await mkdir(this.paths.controlDirectory, { recursive: true })
      const handle = await open(this.paths.controlEventsFile, 'a', 0o600)
      try {
        await writeFull(handle, line)
      } finally {
        await handle.close()
      }

      if (options.mutation) {
        this.applyCommittedMutation(options.mutation)
      }

      if (event) {
        this.state.events.push(event)
        if (this.state.events.length > this.capacity) {
          this.state.events.splice(0, this.state.events.length - this.capacity)
        }
      }

      // 无论是事件还是纯 mutation，未压缩差额达标即在当前串行临界区内安全触发压缩
      if (this.state.commitSeq - this.state.appliedCommitSeq >= this.capacity * 2) {
        await this.internalCompact()
      }

      return { entry, event }
    })
  }

  checkpoint(): Promise<void> {
    return this.runQueued(async () => {
      await this.internalCheckpoint()
    })
  }

  private async internalCheckpoint(): Promise<void> {
    // 关键保证：快照只从已提交私有视图捕获，绝不读取外部未经 save 污染的对象
    const snapshot: ControlSnapshot = {
      version: 2,
      journalEpoch: this.state.journalEpoch,
      appliedCommitSeq: this.state.commitSeq,
      seq: this.state.seq,
      projects: [...this.committedProjects.values()].map((p) => structuredClone(p)),
      sessions: [...this.committedSessions.values()].map((s) => structuredClone(s)),
      receipts: [...this.committedReceipts.values()].map((r) => structuredClone(r)),
    }

    await mkdir(this.paths.controlDirectory, { recursive: true })

    // 1. 写入 snapshot.json 并 sync 目录
    const snapTmp = `${this.paths.controlSnapshotFile}.tmp`
    const snapHandle = await open(snapTmp, 'w', 0o600)
    try {
      await writeFull(snapHandle, JSON.stringify(snapshot, null, 2))
    } finally {
      await snapHandle.close()
    }
    await rename(snapTmp, this.paths.controlSnapshotFile)
    await syncDirectory(this.paths.controlDirectory)
    this.state.appliedCommitSeq = snapshot.appliedCommitSeq

    // 2. 压缩 / 同步 operations.jsonl 并 sync 目录
    const opLines: string[] = []
    for (const [id, op] of Object.entries(this.state.operations)) {
      const entry: OperationEntry = {
        id,
        operationId: op.operationId,
        input: op.input,
        status: op.status,
        result: op.result,
        error: op.error,
        timestamp: new Date().toISOString(),
      }
      opLines.push(JSON.stringify(entry))
    }
    const opTmp = `${this.paths.controlOperationsFile}.tmp`
    const opHandle = await open(opTmp, 'w', 0o600)
    try {
      if (opLines.length) {
        await writeFull(opHandle, `${opLines.join('\n')}\n`)
      }
    } finally {
      await opHandle.close()
    }
    await rename(opTmp, this.paths.controlOperationsFile)
    await syncDirectory(this.paths.controlDirectory)
  }

  private async internalCompact(): Promise<void> {
    await this.internalCheckpoint()

    let content: string
    try {
      content = await readFile(this.paths.controlEventsFile, 'utf8')
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return
      throw cause
    }

    const lines = content.split('\n').filter((l) => Boolean(l.trim()))
    let startIndex = lines.length

    if (this.state.events.length > 0) {
      // 存在事件补读窗口时：保留从窗口内最早事件所在行开始的连续尾段
      const earliestEventSeq = this.state.events[0]!.seq
      for (let i = 0; i < lines.length; i++) {
        const entry = JSON.parse(lines[i]!) as ControlJournalEntry
        validateJournalEntry(entry)
        if (entry.event && entry.event.seq >= earliestEventSeq) {
          startIndex = i
          break
        }
      }
    } else {
      // 纯 mutation 场景：所有 commitSeq <= appliedCommitSeq 的变更已完全落入快照，全部丢弃
      startIndex = lines.length
      for (let i = 0; i < lines.length; i++) {
        const entry = JSON.parse(lines[i]!) as ControlJournalEntry
        validateJournalEntry(entry)
        if (entry.commitSeq > this.state.appliedCommitSeq) {
          startIndex = i
          break
        }
      }
    }

    const keptLines = lines.slice(startIndex)
    const tmp = `${this.paths.controlEventsFile}.tmp`
    const eventsHandle = await open(tmp, 'w', 0o600)
    try {
      if (keptLines.length) {
        await writeFull(eventsHandle, `${keptLines.join('\n')}\n`)
      }
    } finally {
      await eventsHandle.close()
    }
    await rename(tmp, this.paths.controlEventsFile)
    await syncDirectory(this.paths.controlDirectory)
  }

  save(): Promise<void> {
    return this.runQueued(async () => {
      await this.internalCompact()
    })
  }

  async saveProject(project: AppProject): Promise<void> {
    await this.commitJournal({
      mutation: { kind: 'project_upsert', project: structuredClone(project) },
    })
  }

  async saveSession(session: AppSession): Promise<void> {
    await this.commitJournal({
      mutation: { kind: 'session_upsert', session: structuredClone(session) },
    })
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.commitJournal({
      mutation: { kind: 'session_delete', sessionId },
    })
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
    if (this.poisoned) {
      throw new ControlError('store-poisoned', this.poisonError?.message ?? '存储已锁定，拒绝执行操作')
    }
    const id = JSON.stringify([clientId, key])
    const input = createHash('sha256')
      .update(JSON.stringify([method, args]))
      .digest('hex')
    const previous = this.state.operations[id]
    if (previous) {
      if (previous.input !== input) throw new ControlError('idempotency-conflict', '幂等键已经用于不同内容')
      if (this.running.has(id)) return this.running.get(id) as Promise<T>
      if (previous.status === 'completed') {
        const receipt = this.committedReceipts.get(previous.operationId)
        if (receipt) return structuredClone(receipt) as T
        return structuredClone(previous.result) as T
      }
      if (previous.status === 'interrupted' && this.committedReceipts.has(previous.operationId))
        return structuredClone(this.committedReceipts.get(previous.operationId)) as T
      throw new ControlError(previous.status, previous.error ?? '操作已经中断，不会重新执行')
    }

    const operation: Operation = { operationId: randomUUID(), input, status: 'pending' }
    this.state.operations[id] = operation

    const pending = (async () => {
      try {
        await this.appendOperation({
          id,
          operationId: operation.operationId,
          input,
          status: 'pending',
          timestamp: new Date().toISOString(),
        })
        const result = await action(operation.operationId)
        operation.result = result
        operation.status = 'completed'
        await this.appendOperation({
          id,
          operationId: operation.operationId,
          input,
          status: 'completed',
          result,
          timestamp: new Date().toISOString(),
        })
        return structuredClone(result)
      } catch (cause) {
        operation.status = 'failed'
        operation.error = cause instanceof Error ? cause.message : String(cause)
        await this.appendOperation({
          id,
          operationId: operation.operationId,
          input,
          status: 'failed',
          error: operation.error,
          timestamp: new Date().toISOString(),
        }).catch(() => {})
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
    companionSession?: AppSession,
  ): Promise<HostControlEvent> {
    if (this.poisoned) {
      throw new ControlError('store-poisoned', this.poisonError?.message ?? '存储已锁定，拒绝发布事件')
    }
    const eventId = randomUUID()
    const timestamp = new Date().toISOString()

    let mutation: ControlJournalMutation | undefined
    if (input.type === 'session') {
      mutation = { kind: 'session_upsert', session: structuredClone(input.value as AppSession) }
    } else if (input.type === 'submission') {
      const receipt = structuredClone(input.value as SubmissionReceipt)
      if (companionSession) {
        mutation = {
          kind: 'session_receipt_upsert',
          session: structuredClone(companionSession),
          receipt,
        }
      } else {
        mutation = { kind: 'receipt_upsert', receipt }
      }
    }

    const { event } = await this.commitJournal({
      mutation,
      eventInput: {
        type: input.type,
        value: input.value,
        sessionId: input.sessionId,
        projectId: input.projectId,
        eventId,
        timestamp,
      },
    })

    const createdEvent = event!
    for (const listener of this.listeners) {
      if (matchesControlEvent(createdEvent, listener.input)) {
        try {
          listener.callback(createdEvent)
        } catch {
          /* 单个订阅者不能中断已保存的事件。 */
        }
      }
    }
    return createdEvent
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
    await this.queue
  }
}
