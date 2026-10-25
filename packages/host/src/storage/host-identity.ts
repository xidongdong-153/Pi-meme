import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createHostStoragePaths } from './paths'
import { readJson, writeText } from './files'

type RecordValue = Record<string, unknown>

function object(value: unknown): RecordValue | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : undefined
}

async function controlHostIdentities(root: string) {
  const paths = createHostStoragePaths(root)
  const identities = new Map<string, string>()
  const ref = (value: unknown, location: string) => {
    const record = object(value)
    if (!record || !('hostId' in record)) return
    if (typeof record.hostId !== 'string' || !record.hostId.trim()) throw new Error(`Host 身份无效：${location}`)
    identities.set(record.hostId, location)
  }
  const entity = (value: unknown, location: string) => {
    const record = object(value)
    if (!record) return
    ref(record, location)
    for (const key of ['project', 'session']) ref(record[key], `${location}.${key}`)
    for (const key of ['receipt', 'goal']) {
      const nested = object(record[key])
      if (nested) ref(nested.session, `${location}.${key}.session`)
    }
  }
  const event = (value: unknown, location: string) => {
    const record = object(value)
    if (!record) return
    ref(record, location)
    if (record.type === 'session' || record.type === 'submission') entity(record.value, `${location}.value`)
  }
  const state = (value: unknown, location: string) => {
    const record = object(value)
    if (!record) throw new Error(`控制状态格式无效：${location}`)
    for (const key of ['projects', 'sessions', 'receipts']) {
      const rows = record[key]
      if (Array.isArray(rows)) rows.forEach((row, index) => entity(row, `${location}.${key}[${index}]`))
    }
    if (Array.isArray(record.events)) record.events.forEach((row, index) => event(row, `${location}.events[${index}]`))
    const operations = object(record.operations)
    if (operations)
      for (const [key, operation] of Object.entries(operations))
        entity(object(operation)?.result, `${location}.operations[${key}].result`)
  }
  for (const file of [path.join(root, 'control.json'), paths.controlSnapshotFile]) {
    const value = await readJson<unknown>(file)
    if (value !== undefined) state(value, file)
  }
  for (const file of [paths.controlEventsFile, paths.controlOperationsFile]) {
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw cause
    }
    // 未完成的尾行留给控制存储的崩溃恢复处理。
    for (const [index, line] of text.split('\n').slice(0, -1).entries()) {
      if (!line.trim()) continue
      const location = `${file}:${index + 1}`
      const entry = object(JSON.parse(line))
      if (!entry) throw new Error(`控制日志格式无效：${location}`)
      event(entry.event, `${location}.event`)
      const mutation = object(entry.mutation)
      if (mutation)
        for (const key of ['project', 'session', 'receipt']) entity(mutation[key], `${location}.mutation.${key}`)
      entity(entry.result, `${location}.result`)
    }
  }
  return identities
}

function assertIdentities(identities: Map<string, string>, hostId: string) {
  for (const [stored, location] of identities)
    if (stored !== hostId)
      throw new Error(
        `Host 身份不一致：${location} 记录为 ${JSON.stringify(stored)}，当前为 ${JSON.stringify(hostId)}；请先备份并修复身份引用`,
      )
}

export async function assertControlHostIdentity(root: string, hostId: string) {
  assertIdentities(await controlHostIdentities(root), hostId)
}

export async function assertStorageHostIdentity(root: string, hostId: string) {
  const file = createHostStoragePaths(root).hostIdFile
  const stored = (await readFile(file, 'utf8')).trim()
  if (!stored || stored !== hostId) throw new Error(`持久 Host 身份不匹配：${file}`)
  await assertControlHostIdentity(root, hostId)
}

export async function ensureHostIdentity(root: string) {
  const file = createHostStoragePaths(root).hostIdFile
  let stored: string | undefined
  try {
    stored = (await readFile(file, 'utf8')).trim()
    if (!stored) throw new Error(`host-id 文件内容为空：${file}`)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
  }
  const identities = await controlHostIdentities(root)
  if (!stored && identities.size > 1) throw new Error(`缺少 ${file} 且控制状态含有多个 Host 身份；请先备份并恢复原身份`)
  const hostId = stored ?? identities.keys().next().value?.trim() ?? randomUUID()
  assertIdentities(identities, hostId)
  if (!stored) await writeText(file, hostId)
  return hostId
}
