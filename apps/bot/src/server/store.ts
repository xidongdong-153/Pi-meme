import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import lockfile from 'proper-lockfile'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { defineDoc, Harness } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import type { Models } from '@earendil-works/pi-ai/models'
import type { ConversationId, JsonObject, Registry, Tx } from '@earendil-works/pi-durable'
import type { AppState } from '../shared/types.js'
import type { BotStore } from './contracts.js'
import { BotError } from './errors.js'
import { ensureBotConversation, fixedBotConversation } from './bot-conversations.js'
import { migrateModelState } from './model-settings.js'

export const context = BACKGROUND_CONTEXT

function resourceMaps(state: AppState): AppState {
  for (const key of [
    'bots',
    'models',
    'modelServices',
    'conversations',
    'messages',
    'tasks',
    'hosts',
    'schedules',
    'scheduleRuns',
    'memories',
    'attachments',
    'generations',
    'deliveries',
    'tokens',
    'sessions',
    'operations',
    'inboundIds',
  ] as const)
    Object.setPrototypeOf(state[key], null)
  return state
}
export const businessState = defineDoc<JsonObject>({
  kind: 'pi-meme-bot.state',
  version: 2,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({
    schemaVersion: 2,
    epoch: randomUUID(),
    seq: 0,
    credentialGeneration: 1,
    bots: {},
    models: {},
    modelServices: {},
    modelSettings: { revision: 1, defaultModelId: null, defaultAssistantId: null, initialized: false },
    conversations: {},
    messages: {},
    tasks: {},
    hosts: {},
    qq: { revision: 1, enabled: false, appId: '', defaultBotId: '', status: 'disabled' },
    schedules: {},
    scheduleRuns: {},
    memories: {},
    attachments: {},
    generations: {},
    deliveries: {},
    tokens: {},
    sessions: {},
    operations: {},
    inboundIds: {},
    events: [],
    settings: { webEnabled: false, allowedWebDomains: [], reducedMotion: false },
  }),
  migrate: (value, fromVersion) => {
    if (fromVersion !== 1 || value.schemaVersion !== 1) throw new Error('Bots 数据版本不兼容，请先备份并迁移')
    return JSON.parse(JSON.stringify(migrateModelState(value as unknown as AppState))) as JsonObject
  },
  checkpointWhen: () => true,
})

export class DurableBotStore implements BotStore {
  private cache!: AppState
  private queue: Promise<unknown> = Promise.resolve()
  private release!: () => Promise<void>
  readonly directory: string
  harness!: Harness
  rootId!: ConversationId
  private constructor(directory: string) {
    this.directory = directory
  }

  static async open(models: Models, registry: Registry, options: { directory?: string } = {}) {
    const store = new DurableBotStore(options.directory ?? join(homedir(), '.pi-meme-bot'))
    for (const name of ['', 'config', 'state', 'credentials', 'attachments', 'resources', 'logs', 'cache', 'runtime']) {
      const path = join(store.directory, name)
      await mkdir(path, { recursive: true, mode: 0o700 })
      const stat = await lstat(path)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Bots 存储目录不可使用符号链接：${path}`)
      await chmod(path, 0o700)
    }
    store.release = await lockfile.lock(store.directory, {
      realpath: true,
      lockfilePath: join(store.directory, 'runtime', 'owner.lock'),
      stale: 30_000,
      update: 10_000,
      retries: 0,
    })
    try {
      const db = join(store.directory, 'state', 'bots.sqlite')
      try {
        if ((await lstat(db)).isSymbolicLink()) throw new Error('Bots 数据库不可使用符号链接')
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
      }
      store.harness = await Harness.open(
        await openNodeSqliteStorage(db),
        { models, registry, settings: { retry: { maxRetries: 0 } } },
        context,
      )
      await chmod(db, 0o600)
      const root = await store.harness.root(context)
      store.rootId = root.id
      await root.commit(async (tx) => {
        await tx.doc(businessState, root.id)
      }, context)
      store.cache = (await store.harness.snapshot(businessState, root.id, context)) as unknown as AppState
      if (store.cache.schemaVersion !== 2) throw new Error('Bots 数据版本不兼容，请先备份并迁移')
      if (
        Object.values(store.cache.bots).some((bot) => {
          const conversation = fixedBotConversation(store.cache, bot)
          return !conversation || conversation.archived || bot.webConversationId !== conversation.id
        })
      )
        await store.update((state) => {
          for (const bot of Object.values(state.bots)) ensureBotConversation(state, bot.id)
        })
      return store
    } catch (cause) {
      await store.release()
      throw cause
    }
  }

  read(): AppState {
    return resourceMaps(structuredClone(this.cache))
  }

  update<T>(change: (draft: AppState, tx: Tx) => T | Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      let result: T
      const root = await this.harness.conversation(this.rootId, context)
      if (!root) throw new Error('Bots 业务状态不可用')
      await root.commit(async (tx) => {
        const document = await tx.doc(businessState, this.rootId)
        const state = resourceMaps(JSON.parse(JSON.stringify(document)) as AppState)
        result = await change(state, tx)
        state.seq++
        state.events.push({ id: randomUUID(), seq: state.seq, type: 'change', time: new Date().toISOString() })
        if (state.events.length > 1000) state.events.splice(0, state.events.length - 1000)
        const persisted = JSON.parse(JSON.stringify(state)) as JsonObject
        for (const key of Object.keys(document)) if (!Object.hasOwn(persisted, key)) delete document[key]
        Object.assign(document, persisted)
        const value = result === undefined ? undefined : JSON.parse(JSON.stringify(result))
        result = value as T
      }, context)
      this.cache = (await this.harness.snapshot(businessState, this.rootId, context)) as unknown as AppState
      return result!
    })
    this.queue = next.catch(() => {})
    return next
  }

  private secretPath(ref: string) {
    if (!/^[\da-f-]{36}$/.test(ref)) throw new BotError(400, 'invalid-input', '凭据引用无效')
    return join(this.directory, 'credentials', ref)
  }
  async secret(ref: string | undefined) {
    if (!ref) return undefined
    const path = this.secretPath(ref)
    try {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        if (!(await file.stat()).isFile()) throw new BotError(403, 'forbidden', '凭据路径无效')
        return await file.readFile('utf8')
      } finally {
        await file.close()
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      if ((cause as NodeJS.ErrnoException).code === 'ELOOP') throw new BotError(403, 'forbidden', '凭据路径无效')
      throw cause
    }
  }
  async writeSecret(value: string) {
    const ref = randomUUID()
    await writeFile(this.secretPath(ref), value, { mode: 0o600, flag: 'wx' })
    return ref
  }
  async deleteSecret(ref: string | undefined) {
    if (ref)
      await unlink(this.secretPath(ref)).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code !== 'ENOENT') throw cause
      })
  }
  async close() {
    await this.queue
    try {
      await this.harness.close(context)
    } finally {
      await this.release()
    }
  }
}
