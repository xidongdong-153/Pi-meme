import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import type { AgentAccessMode } from '@pi-meme/contracts/agent-access'
import type { SessionRef } from '@pi-meme/contracts/app-host'
import {
  isLiveServiceActivity,
  type ServiceActivity,
  type ServiceActivityList,
  type ServiceActivityLogs,
} from '@pi-meme/contracts/service-activity'
import { AccessSandbox, pathWithin } from '@pi-meme/pi-runtime/sdk/access-sandbox'
import {
  serviceProcessEnvironment,
  spawnManagedProcess,
  type ManagedProcess,
  type ManagedProcessExit,
} from '@pi-meme/pi-runtime/sdk/managed-process'

export type ActivityCaller = {
  session: SessionRef
  cwd: string
  agentDir: string
  accessMode: AgentAccessMode
  sourceAgentId?: string
  sourceName: string
}
type StartInput = { name: string; command: string; cwd?: string; requestId: string }
type ActivityRecord = {
  activity: ServiceActivity
  output: Buffer
  sequence: number
  truncated: boolean
  temporary?: string
  child?: ManagedProcess
  starting?: Promise<ServiceActivity>
  completed?: Promise<void>
  logTimer?: ReturnType<typeof setTimeout>
}
type Options = {
  hostId: string
  dataRoot: string
  onChange: (activity: ServiceActivity) => void
  onLogs?: (event: { session: SessionRef; serviceId: string; sequence: number }) => void
}
const logLimit = 256 * 1024
const endedLimit = 64

function text(value: unknown, label: string, limit: number): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || value.includes('\0'))
    throw new Error(`${label}无效`)
}

/** Host 持有的服务生命周期，不随 Worker 或界面卸载释放。 */
export class ActivityService {
  private readonly records = new Map<string, ActivityRecord>()
  private readonly requests = new Map<string, { serviceId: string; input: string }>()
  private revision = 0
  private closing = false

  constructor(private readonly options: Options) {}

  private checkRef(ref: SessionRef) {
    if (ref.hostId !== this.options.hostId) throw new Error('活动所属 Host 不匹配')
    text(ref.sessionId, '会话标识', 256)
  }

  private record(ref: SessionRef, serviceId: string) {
    this.checkRef(ref)
    const record = this.records.get(serviceId)
    if (!record || record.activity.sessionId !== ref.sessionId) throw new Error('服务不存在或不属于此会话')
    return record
  }

  private change(record: ActivityRecord) {
    record.activity.revision = ++this.revision
    this.options.onChange(structuredClone(record.activity))
  }

  private prune() {
    const ended = [...this.records.values()].filter((record) => !isLiveServiceActivity(record.activity))
    for (const record of ended.slice(0, Math.max(0, ended.length - endedLimit))) {
      this.records.delete(record.activity.serviceId)
      for (const [key, request] of this.requests)
        if (request.serviceId === record.activity.serviceId) this.requests.delete(key)
    }
  }

  start(caller: ActivityCaller, input: StartInput, signal?: AbortSignal): Promise<ServiceActivity> {
    if (this.closing) return Promise.reject(new Error('Host 活动服务已关闭'))
    this.checkRef(caller.session)
    if (process.platform !== 'darwin' && process.platform !== 'linux')
      return Promise.reject(new Error(`当前平台不支持受管服务：${process.platform}`))
    text(input.name, '服务名称', 120)
    text(input.command, '服务命令', 16 * 1024)
    text(input.requestId, '启动请求标识', 256)
    if (input.cwd !== undefined) text(input.cwd, '服务目录', 4096)
    const identity = JSON.stringify([caller.session.sessionId, caller.sourceAgentId, input.requestId])
    const serialized = JSON.stringify([input.name, input.command, input.cwd])
    const previous = this.requests.get(identity)
    if (previous) {
      if (previous.input !== serialized) return Promise.reject(new Error('同一启动请求不能改用其他命令'))
      const record = this.record(caller.session, previous.serviceId)
      return record.starting ?? Promise.resolve(structuredClone(record.activity))
    }
    if (signal?.aborted) return Promise.reject(new Error('服务启动已取消'))
    const live = [...this.records.values()].filter((entry) => isLiveServiceActivity(entry.activity))
    if (live.length >= 16 || live.filter((entry) => entry.activity.sessionId === caller.session.sessionId).length >= 8)
      return Promise.reject(new Error('活动服务数量已达上限，请先停止不用的服务'))
    const activity: ServiceActivity = {
      hostId: caller.session.hostId,
      sessionId: caller.session.sessionId,
      serviceId: randomUUID(),
      name: input.name,
      command: input.command,
      cwd: path.resolve(caller.cwd, input.cwd ?? '.'),
      sourceAgentId: caller.sourceAgentId,
      sourceName: caller.sourceName,
      accessMode: caller.accessMode,
      status: 'starting',
      startedAt: new Date().toISOString(),
      urls: [],
      revision: 0,
    }
    const record: ActivityRecord = { activity, output: Buffer.alloc(0), sequence: 0, truncated: false }
    this.records.set(activity.serviceId, record)
    this.requests.set(identity, { serviceId: activity.serviceId, input: serialized })
    this.change(record)
    record.starting = this.launch(record, caller, signal)
    return record.starting
  }

  private async launch(record: ActivityRecord, caller: ActivityCaller, signal?: AbortSignal) {
    const activity = record.activity
    try {
      const [workspace, cwd] = await Promise.all([realpath(caller.cwd), realpath(activity.cwd)])
      if (caller.accessMode !== 'full-access' && !pathWithin(workspace, cwd))
        throw new Error('当前权限不允许在工作区外启动服务')
      activity.cwd = cwd
      record.temporary = await realpath(await mkdtemp(path.join(tmpdir(), 'pi-activity-')))
      const onData = (chunk: Buffer) => this.output(record, chunk)
      const child =
        caller.accessMode === 'full-access'
          ? () =>
              spawnManagedProcess('/bin/bash', ['-c', activity.command], {
                cwd,
                env: serviceProcessEnvironment({ TMPDIR: record.temporary }),
                onData,
              })
          : await AccessSandbox.create({
              mode: caller.accessMode,
              cwd: workspace,
              temporary: record.temporary,
              agentDir: caller.agentDir,
              dataRoot: this.options.dataRoot,
            }).then(
              (sandbox) => () =>
                sandbox.startManaged('/bin/bash', ['-c', activity.command], {
                  cwd,
                  env: { TMPDIR: record.temporary },
                  onData,
                }),
            )
      if (signal?.aborted || this.closing || activity.status === 'stopping') throw new Error('服务启动已取消')
      record.child = await child()
      record.completed = record.child.completion.then(
        (result) => this.finish(record, result),
        (cause) => {
          activity.status = 'stopping'
          activity.lastError = String(cause)
          this.change(record)
          throw cause
        },
      )
      void record.completed.catch(() => {})
      if (signal?.aborted || this.closing || record.activity.stopReason) {
        activity.stopReason = '启动取消'
        const result = await record.child.stop()
        await record.completed.catch(() => {})
        if (isLiveServiceActivity(activity)) await this.finish(record, result)
        throw new Error('服务启动已取消')
      }
      activity.status = 'running'
      this.change(record)
      return structuredClone(activity)
    } catch (cause) {
      if (!record.child) {
        activity.status = activity.stopReason || signal?.aborted || this.closing ? 'stopped' : 'failed'
        if (activity.status === 'stopped') activity.stopReason ??= '启动取消'
        else activity.lastError = String(cause)
        activity.endedAt = new Date().toISOString()
        await this.cleanTemporary(record)
        this.change(record)
        this.prune()
      }
      throw cause
    } finally {
      record.starting = undefined
    }
  }

  private async finish(record: ActivityRecord, result: ManagedProcessExit) {
    if (record.activity.endedAt) return
    const activity = record.activity
    activity.exitCode = result.exitCode ?? undefined
    activity.signal = result.signal ?? undefined
    activity.status = activity.stopReason ? 'stopped' : result.exitCode === 0 ? 'exited' : 'failed'
    activity.endedAt = new Date().toISOString()
    activity.lastError = undefined
    clearTimeout(record.logTimer)
    record.logTimer = undefined
    await this.cleanTemporary(record)
    this.change(record)
    this.prune()
  }

  private async cleanTemporary(record: ActivityRecord) {
    if (!record.temporary) return
    try {
      await rm(record.temporary, { recursive: true, force: true })
      record.temporary = undefined
    } catch (cause) {
      record.activity.lastError = `服务已退出，但临时目录清理失败：${String(cause)}`
    }
  }

  private output(record: ActivityRecord, chunk: Buffer) {
    record.sequence++
    if (this.options.onLogs && !record.logTimer) {
      record.logTimer = setTimeout(() => {
        record.logTimer = undefined
        this.options.onLogs?.({
          session: { hostId: record.activity.hostId, sessionId: record.activity.sessionId },
          serviceId: record.activity.serviceId,
          sequence: record.sequence,
        })
      }, 250)
      record.logTimer.unref()
    }
    const output = Buffer.concat([record.output, chunk])
    if (output.byteLength > logLimit) record.truncated = true
    record.output = output.subarray(Math.max(0, output.byteLength - logLimit))
    const clean = stripVTControlCharacters(chunk.toString('utf8'))
    let changed = false
    for (const match of clean.matchAll(/https?:\/\/[^\s<>"'`]+/g)) {
      try {
        const url = new URL(match[0].replace(/[),.;\]]+$/, ''))
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue
        if (url.href.length > 2048 || record.activity.urls.includes(url.href) || record.activity.urls.length >= 6)
          continue
        record.activity.urls.push(url.href)
        changed = true
      } catch {
        // 日志中的不完整地址不是可打开的链接。
      }
    }
    if (changed) this.change(record)
  }

  list(ref: SessionRef): ServiceActivityList {
    this.checkRef(ref)
    return {
      activities: [...this.records.values()]
        .filter((record) => record.activity.sessionId === ref.sessionId)
        .map((record) => structuredClone(record.activity)),
      revision: this.revision,
    }
  }

  logs(ref: SessionRef, serviceId: string): ServiceActivityLogs {
    const record = this.record(ref, serviceId)
    return { output: record.output.toString('utf8'), sequence: record.sequence, truncated: record.truncated }
  }

  async stop(ref: SessionRef, serviceId: string, reason = '用户停止') {
    const record = this.record(ref, serviceId)
    if (!isLiveServiceActivity(record.activity)) return structuredClone(record.activity)
    record.activity.stopReason = reason
    record.activity.status = 'stopping'
    this.change(record)
    if (record.starting) await record.starting.catch(() => {})
    if (record.child && isLiveServiceActivity(record.activity)) {
      try {
        const result = await record.child.stop()
        await record.completed?.catch(() => {})
        if (isLiveServiceActivity(record.activity)) await this.finish(record, result)
      } catch (cause) {
        record.activity.lastError = String(cause)
        this.change(record)
        throw cause
      }
    }
    return structuredClone(record.activity)
  }

  assertIdle(cwd?: string) {
    if (
      [...this.records.values()].some(
        ({ activity }) =>
          isLiveServiceActivity(activity) && (!cwd || pathWithin(cwd, activity.cwd) || pathWithin(activity.cwd, cwd)),
      )
    )
      throw new Error('仍有活动服务，请先在活动面板停止服务')
  }

  async dispose() {
    this.closing = true
    const results = await Promise.allSettled(
      [...this.records.values()]
        .filter((record) => isLiveServiceActivity(record.activity))
        .map((record) => this.stop(record.activity, record.activity.serviceId, 'Host 正常退出')),
    )
    const failed = results.find((result) => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }
}
