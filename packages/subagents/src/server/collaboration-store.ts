import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import type {
  AgentMailboxMessage,
  AgentRunRef,
  AgentSummary,
  CollaborationResults,
  PendingInteraction,
} from '@pi-meme/contracts/collaboration'
import { isPlanDocument, type PlanDocument, type PlanState, type TaskMode } from '@pi-meme/contracts/plan'

export type PersistedAgentRecord = {
  summary: AgentSummary
  delegation?: AgentRunRef[]
  mailbox: AgentMailboxMessage[]
  consumed: string[]
  queued: Array<{
    message: string
    rootTaskId: string
    epoch: number
    policy: Pick<AgentSummary, 'mode' | 'accessMode' | 'model' | 'thinkingLevel'>
    runId: string
    delegation?: AgentRunRef[]
  }>
  interactions: PendingInteraction[]
  sequence: number
  settled?: boolean
  completion?: { report: string }
  feedbackSent?: boolean
  nextMode?: TaskMode
  replies?: Array<{ id: string; result: CollaborationResults[keyof CollaborationResults] }>
}

export type CollaborationRootPartition = {
  version: 1 | 2
  rootAgentId: string
  rootSessionKey: string
  records: PersistedAgentRecord[]
  updatedAt: string
}

export type CollaborationPlansIndex = {
  version: 1 | 2
  plans: PlanDocument[]
  states?: PlanState[]
}

const safeIdPattern = /^[\w-]+$/

export function assertSafeId(id: string, name = 'ID'): void {
  if (!id || typeof id !== 'string' || !safeIdPattern.test(id)) {
    throw new TypeError(`非法安全 ${name}：${id}`)
  }
}

async function atomicWrite(file: string, content: string) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(content)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, file)
    if (process.platform !== 'win32') {
      const parent = await open(path.dirname(file), 'r')
      try {
        await parent.sync()
      } finally {
        await parent.close()
      }
    }
  } finally {
    await rm(temporary, { force: true })
  }
}

/** 纯数据迁移：将旧 collaboration.json 结构严格校验并转换为根分片和计划索引 */
export function migrateLegacyCollaborationJson(legacy: { records?: unknown[]; plans?: unknown[] }): {
  roots: Map<string, CollaborationRootPartition>
  plans: PlanDocument[]
} {
  if (!legacy || typeof legacy !== 'object') {
    throw new Error('旧协作数据格式损坏：必须为非空对象')
  }

  const rawRecords = legacy.records
  if (rawRecords !== undefined && !Array.isArray(rawRecords)) {
    throw new Error('旧协作数据损坏：records 必须为数组')
  }

  const rawPlans = legacy.plans
  if (rawPlans !== undefined && !Array.isArray(rawPlans)) {
    throw new Error('旧协作数据损坏：plans 必须为数组')
  }

  const plans: PlanDocument[] = []
  for (const rawPlan of rawPlans ?? []) {
    if (
      !rawPlan ||
      typeof rawPlan !== 'object' ||
      typeof (rawPlan as PlanDocument).id !== 'string' ||
      typeof (rawPlan as PlanDocument).sessionId !== 'string' ||
      typeof (rawPlan as PlanDocument).title !== 'string' ||
      typeof (rawPlan as PlanDocument).markdown !== 'string'
    ) {
      throw new Error('旧计划数据损坏：计划条目字段无效')
    }
    plans.push(rawPlan as PlanDocument)
  }

  const roots = new Map<string, CollaborationRootPartition>()

  for (let index = 0; index < (rawRecords ?? []).length; index++) {
    const raw = (rawRecords as unknown[])[index]
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`旧协作记录索引 [${index}] 损坏：条目必须为对象`)
    }
    const recordObj = raw as Record<string, unknown>
    const summary = recordObj.summary as Record<string, unknown> | undefined
    if (!summary || typeof summary !== 'object') {
      throw new Error(`旧协作记录索引 [${index}] 损坏：缺少有效 summary 字段`)
    }

    const agentId = summary.agentId
    if (typeof agentId !== 'string' || !agentId.trim()) {
      throw new Error(`旧协作记录索引 [${index}] 损坏：缺少必需的 summary.agentId`)
    }
    const rootAgentId =
      typeof summary.rootAgentId === 'string' && summary.rootAgentId.trim() ? summary.rootAgentId : agentId
    assertSafeId(rootAgentId, 'rootAgentId')

    const rootSessionKey = typeof summary.rootSessionKey === 'string' ? summary.rootSessionKey : ''

    const sanitizedRecord: PersistedAgentRecord = {
      summary: {
        ...(summary as unknown as AgentSummary),
        agentId,
        rootAgentId,
        isPaused: undefined,
      },
      mailbox: Array.isArray(recordObj.mailbox)
        ? (recordObj.mailbox as AgentMailboxMessage[]).map((message) => ({ ...message, historyOnly: true }))
        : [],
      consumed: Array.isArray(recordObj.consumed) ? (recordObj.consumed as string[]) : [],
      queued: Array.isArray(recordObj.queued) ? (recordObj.queued as PersistedAgentRecord['queued']) : [],
      interactions: [],
      sequence: typeof recordObj.sequence === 'number' ? recordObj.sequence : 0,
      settled: typeof recordObj.settled === 'boolean' ? recordObj.settled : undefined,
      completion: recordObj.completion as PersistedAgentRecord['completion'],
      feedbackSent: typeof recordObj.feedbackSent === 'boolean' ? recordObj.feedbackSent : undefined,
      nextMode: recordObj.nextMode as TaskMode | undefined,
      replies: Array.isArray(recordObj.replies) ? (recordObj.replies as PersistedAgentRecord['replies']) : undefined,
    }

    let partition = roots.get(rootAgentId)
    if (!partition) {
      partition = {
        version: 2,
        rootAgentId,
        rootSessionKey,
        records: [],
        updatedAt: typeof summary.updatedAt === 'string' ? summary.updatedAt : new Date().toISOString(),
      }
      roots.set(rootAgentId, partition)
    }
    if (sanitizedRecord.summary.depth === 0 && sanitizedRecord.summary.rootSessionKey) {
      partition.rootSessionKey = sanitizedRecord.summary.rootSessionKey
    }
    partition.records.push(sanitizedRecord)
  }

  return { roots, plans }
}

/** 从分片目录读取所有根分片及计划索引（严格 fail-closed） */
export function validateCollaborationPlansIndex(data: unknown): asserts data is CollaborationPlansIndex {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('协作计划索引必须是对象')
  const index = data as Partial<CollaborationPlansIndex>
  if (
    ![1, 2].includes(index.version ?? 0) ||
    !Array.isArray(index.plans) ||
    (index.version === 2 && !Array.isArray(index.states))
  ) {
    throw new Error('协作计划索引损坏或版本不受支持')
  }
}

export function validateCollaborationRootPartition(
  data: unknown,
  expectedRootId?: string,
): asserts data is CollaborationRootPartition {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('协作根分片必须是对象')
  const partition = data as Partial<CollaborationRootPartition>
  if (
    ![1, 2].includes(partition.version ?? 0) ||
    typeof partition.rootAgentId !== 'string' ||
    !Array.isArray(partition.records)
  ) {
    throw new Error('协作根分片损坏或版本不支持')
  }
  if (expectedRootId !== undefined && partition.rootAgentId !== expectedRootId) {
    throw new Error(`协作根分片 ID 不一致：期望为 ${expectedRootId}，记录内部为 ${partition.rootAgentId}`)
  }
}

export async function loadCollaborationPartitions(
  rootsDirectory: string,
  plansFile: string,
): Promise<{ roots: Map<string, CollaborationRootPartition>; plans: PlanDocument[]; states: PlanState[] }> {
  const roots = new Map<string, CollaborationRootPartition>()
  let plans: PlanDocument[] = []
  let states: PlanState[] = []

  // 1. 读取 plans.json
  try {
    const plansContent = await readFile(plansFile, 'utf8')
    const parsed = JSON.parse(plansContent) as unknown
    validateCollaborationPlansIndex(parsed)
    plans = parsed.plans.filter(isPlanDocument)
    states = (parsed.states ?? []).filter(
      (state) =>
        state &&
        typeof state.sessionId === 'string' &&
        /^[\w-]+$/.test(state.sessionId) &&
        Number.isSafeInteger(state.revision) &&
        state.revision >= 0 &&
        (!state.document || (isPlanDocument(state.document) && state.document.sessionId === state.sessionId)) &&
        (!state.sourceEntryId || typeof state.sourceEntryId === 'string'),
    )
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
  }

  // 2. 读取 roots/*.json
  try {
    const entries = await readdir(rootsDirectory, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const baseName = entry.name.slice(0, -5)
      assertSafeId(baseName, '分片文件名')

      const filePath = path.join(rootsDirectory, entry.name)
      const content = await readFile(filePath, 'utf8')
      const partition = JSON.parse(content) as unknown
      validateCollaborationRootPartition(partition, baseName)
      roots.set(
        partition.rootAgentId,
        partition.version === 1
          ? {
              ...partition,
              version: 2,
              records: partition.records.map((record) => ({
                ...record,
                mailbox: record.mailbox.map((message) =>
                  message.toRunId ? message : { ...message, historyOnly: true },
                ),
              })),
            }
          : partition,
      )
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
  }

  return { roots, plans, states }
}

/** 单个根分片原子持久化（支持传入已冻结的 payload 字符串） */
export async function saveCollaborationRoot(
  rootsDirectory: string,
  rootAgentId: string,
  partitionOrPayload: CollaborationRootPartition | string,
): Promise<void> {
  assertSafeId(rootAgentId, 'rootAgentId')
  const file = path.join(rootsDirectory, `${rootAgentId}.json`)
  const content =
    typeof partitionOrPayload === 'string' ? partitionOrPayload : `${JSON.stringify(partitionOrPayload, null, 2)}\n`
  await atomicWrite(file, content)
}

/** 单个根分片删除 */
export async function deleteCollaborationRoot(rootsDirectory: string, rootAgentId: string): Promise<void> {
  assertSafeId(rootAgentId, 'rootAgentId')
  const file = path.join(rootsDirectory, `${rootAgentId}.json`)
  await rm(file, { force: true })
}

/** 计划索引原子持久化 */
export async function saveCollaborationPlans(
  plansFile: string,
  plans: PlanDocument[],
  states: PlanState[] = [],
): Promise<void> {
  const payload: CollaborationPlansIndex = {
    version: 2,
    plans,
    states,
  }
  await atomicWrite(plansFile, `${JSON.stringify(payload, null, 2)}\n`)
}
