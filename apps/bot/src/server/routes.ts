import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { streamSSE } from 'hono/streaming'
import type { Context } from 'hono'
import type { AppState, Bot, Capability, Conversation, Memory, ModelConfig, Snapshot } from '../shared/types.js'
import type { BotApp, BotServices } from './contracts.js'
import { authenticate, hash } from './auth.js'
import { BotError, ids, requireItem, revision, text, touch } from './errors.js'
import type { BotRuntime } from './runtime.js'
import { activeTask } from './runtime.js'
import { ensureBotConversation } from './bot-conversations.js'

export function resource() {
  const now = new Date().toISOString()
  return { id: randomUUID(), revision: 1, createdAt: now, updatedAt: now }
}
export async function body(c: Context): Promise<Record<string, unknown>> {
  if (c.req.method === 'DELETE' && c.req.query('revision') !== undefined)
    return { revision: Number(c.req.query('revision')) }
  const value: unknown = await c.req.json()
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BotError(400, 'invalid-input', '请求内容须为JSON对象')
  return value as Record<string, unknown>
}
function removeSecret<T extends { credentialRef?: string; hasCredential?: boolean }>(value: T): T {
  const copy = { ...value, hasCredential: !!value.credentialRef }
  delete copy.credentialRef
  return copy
}

export function snapshot(state: AppState): Snapshot {
  const textAvailable = Object.values(state.models).some(
    (model) =>
      model.kind === 'text' &&
      (!!model.credentialRef ||
        (model.provider === 'openai-compatible' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(new URL(model.baseUrl).hostname))),
  )
  const imagesAvailable = Object.values(state.models).some((model) => model.kind === 'image' && !!model.credentialRef)
  const qq = removeSecret(state.qq)
  delete qq.bindingCodeHash
  delete qq.bindingExpiresAt
  delete qq.sessionId
  delete qq.gatewaySequence
  const tasks = Object.values(state.tasks).map((task) => {
    const copy = { ...task }
    delete copy.modelConfig
    return copy
  })
  return {
    bots: Object.values(state.bots),
    models: Object.values(state.models).map(removeSecret),
    conversations: Object.values(state.conversations),
    tasks,
    hosts: Object.values(state.hosts).map(removeSecret),
    qq,
    schedules: Object.values(state.schedules),
    scheduleRuns: Object.values(state.scheduleRuns),
    memories: Object.values(state.memories),
    attachments: Object.values(state.attachments),
    generations: Object.values(state.generations),
    deliveries: Object.values(state.deliveries),
    tokens: Object.values(state.tokens).map(({ hash: _hash, ...token }) => token),
    settings: state.settings,
    cursor: `${state.epoch}:${state.seq}`,
    capabilities: {
      chat: {
        available: textAvailable,
        reason: textAvailable ? undefined : '请配置文本模型及凭据；本机兼容服务可免密',
      },
      images: { available: imagesAvailable, reason: imagesAvailable ? undefined : '请配置图片模型及凭据' },
      web: {
        available: state.settings.webEnabled,
        reason: state.settings.webEnabled ? '支持公开网页，不包含登录态浏览' : '尚未启用公开网页探索',
      },
      hosts: {
        available: Object.values(state.hosts).some((host) => host.status === 'online'),
        reason: '需要登记并检查可达Host',
      },
      qq: { available: state.qq.status === 'online', reason: state.qq.error ?? '需要官方机器人凭据和本人绑定' },
      schedules: { available: true },
    },
  }
}

function botFields(input: Record<string, unknown>, state: AppState, current?: Bot): Bot {
  const value = { ...current, ...input }
  const capabilities = ids(value.capabilities ?? [], '能力') as Capability[]
  if (capabilities.some((item) => !['collaborate', 'hosts', 'images', 'web', 'schedules'].includes(item)))
    throw new BotError(400, 'invalid-input', '能力名称无效')
  const collaboratorIds = ids(value.collaboratorIds ?? [], '协作角色')
  const hostIds = ids(value.hostIds ?? [], 'Host')
  for (const id of collaboratorIds) requireItem(state.bots[id], '协作角色')
  for (const id of hostIds) requireItem(state.hosts[id], 'Host')
  const modelId = text(value.modelId, '文本模型', 128, true)
  if (modelId && requireItem(state.models[modelId], '模型').kind !== 'text')
    throw new BotError(400, 'invalid-input', '请选择文本模型')
  const maximum = value.maxToolCalls ?? 12
  if (!Number.isInteger(maximum) || Number(maximum) < 1 || Number(maximum) > 32)
    throw new BotError(400, 'invalid-input', '工具调用预算须为1–32整数')
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean')
    throw new BotError(400, 'invalid-input', '启用状态须为布尔值')
  return {
    ...(current ?? resource()),
    name: text(value.name, '名称', 80),
    avatar: text(value.avatar ?? '🤖', '头像', 100, true),
    description: text(value.description, '简介', 1000, true),
    instructions: text(value.instructions, '角色指令', 32000, true),
    modelId,
    enabled: value.enabled !== false,
    capabilities,
    collaboratorIds,
    hostIds,
    maxToolCalls: Number(maximum),
  }
}

function conversationFields(input: Record<string, unknown>, state: AppState, current?: Conversation): Conversation {
  const value = { ...current, ...input }
  const kind = value.kind ?? 'direct'
  if (
    !['direct', 'group', 'qq'].includes(String(kind)) ||
    (!current && kind === 'qq') ||
    (current && kind !== current.kind)
  )
    throw new BotError(400, 'invalid-input', '会话类型无效或不可改变')
  const memberIds = ids(value.memberIds ?? [], '成员', 16)
  if (!memberIds.length || (kind === 'direct' && memberIds.length !== 1) || (kind === 'group' && memberIds.length < 2))
    throw new BotError(400, 'invalid-input', '私聊需1名Bot，群聊需2–16名Bot')
  for (const id of memberIds) requireItem(state.bots[id], '成员')
  if (current?.kind === 'direct' && current.coordinatorId !== memberIds[0])
    throw new BotError(400, 'invalid-input', '私聊角色固定，请选择对应 Bot')
  const coordinatorId = text(value.coordinatorId ?? memberIds[0], '协调者', 128)
  if (!memberIds.includes(coordinatorId)) throw new BotError(400, 'invalid-input', '协调者须为当前成员')
  const memberSince = { ...current?.memberSince }
  for (const id of memberIds) if (!current?.memberIds.includes(id)) memberSince[id] = (current?.sequence ?? 0) + 1
  for (const key of ['pinned', 'archived'] as const)
    if (value[key] !== undefined && typeof value[key] !== 'boolean')
      throw new BotError(400, 'invalid-input', `${key}须为布尔值`)
  return {
    ...(current ?? resource()),
    kind: kind as Conversation['kind'],
    name: text(value.name ?? state.bots[coordinatorId].name, '会话名称', 120),
    memberIds,
    coordinatorId,
    memberSince,
    pinned: value.pinned === true,
    archived: value.archived === true,
    sequence: current?.sequence ?? 0,
  }
}

export function createAttachmentServices(
  store: BotServices['store'],
): Pick<BotServices, 'saveAttachment' | 'readAttachment'> {
  return {
    async saveAttachment(input) {
      if (!input.bytes.length || input.bytes.length > 20 * 1024 * 1024)
        throw new BotError(413, 'invalid-input', '附件须为1字节至20MiB')
      const name = text(input.name, '文件名', 240)
        .replace(/\p{Cc}/gu, '_')
        .replaceAll('/', '_')
        .replaceAll('\\', '_')
      const mime = text(input.mime, '文件类型', 150)
      if (!/^[\w.+-]+\/[\w.+-]+$/.test(mime)) throw new BotError(400, 'invalid-input', '文件类型无效')
      if (input.conversationId) requireItem(store.read().conversations[input.conversationId], '会话')
      const attachment = {
        ...resource(),
        name,
        mime,
        size: input.bytes.length,
        sha256: createHash('sha256').update(input.bytes).digest('hex'),
        objectName: randomUUID(),
        conversationId: input.conversationId,
        taskId: input.taskId,
        generationId: input.generationId,
        source: input.source,
      }
      const file = join(store.directory, 'attachments', attachment.objectName)
      const handle = await open(
        file,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      )
      try {
        await handle.writeFile(input.bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
      try {
        await store.update((state) => {
          if (input.conversationId) requireItem(state.conversations[input.conversationId], '会话')
          state.attachments[attachment.id] = attachment
        })
      } catch (cause) {
        await unlink(file)
        throw cause
      }
      return attachment
    },
    async readAttachment(id) {
      const attachment = requireItem(store.read().attachments[id], '附件')
      if (!/^[\da-f-]{36}$/.test(attachment.objectName)) throw new BotError(403, 'forbidden', '附件对象无效')
      const handle = await open(
        join(store.directory, 'attachments', attachment.objectName),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      ).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code && ['ELOOP', 'ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(cause.code))
          throw new BotError(409, 'attachment-unavailable', '附件文件不可用，请检查文件权限和完整性')
        throw cause
      })
      try {
        const stat = await handle.stat()
        if (!stat.isFile() || stat.size !== attachment.size || stat.size > 20 * 1024 * 1024)
          throw new BotError(409, 'attachment-unavailable', '附件文件缺失或已改变')
        const bytes = await handle.readFile()
        if (createHash('sha256').update(bytes).digest('hex') !== attachment.sha256)
          throw new BotError(409, 'attachment-unavailable', '附件校验失败')
        return bytes
      } finally {
        await handle.close()
      }
    },
  }
}

export function registerCoreRoutes(app: BotApp, services: BotServices, runtime: BotRuntime) {
  const store = services.store
  app.get('/api/v1/snapshot', (c) => c.json(snapshot(store.read())))
  app.get('/api/v1/capabilities', (c) => c.json(snapshot(store.read()).capabilities))
  app.get('/api/v1/bots', (c) => c.json({ items: Object.values(store.read().bots) }))
  app.get('/api/v1/bots/:id', (c) => c.json(requireItem(store.read().bots[c.req.param('id')], 'Bot')))
  app.post('/api/v1/bots', async (c) => {
    const input = await body(c)
    return c.json(
      await store.update((state) => {
        if (Object.keys(state.bots).length >= 200) throw new BotError(409, 'limit-exceeded', '最多200个Bot')
        const bot = botFields(input, state)
        state.bots[bot.id] = bot
        ensureBotConversation(state, bot.id)
        return bot
      }),
      201,
    )
  })
  app.patch('/api/v1/bots/:id', async (c) => {
    const input = await body(c)
    const current = requireItem(store.read().bots[c.req.param('id')], 'Bot')
    const running = Object.values(store.read().tasks).filter((task) => task.botId === current.id && activeTask(task))
    if (input.enabled === false && running.length && input.runningTasks !== 'stop' && input.runningTasks !== 'finish')
      throw new BotError(409, 'active-tasks', '请选择停止或保留正在运行的任务', {
        taskIds: running.map((task) => task.id),
      })
    if (input.enabled === false && input.runningTasks === 'stop')
      await Promise.all(running.map((task) => services.stopTask(task.id)))
    const bot = await store.update((state) => {
      const old = requireItem(state.bots[current.id], 'Bot')
      revision(old, input.revision)
      const updated = botFields(input, state, old)
      touch(updated)
      state.bots[updated.id] = updated
      ensureBotConversation(state, updated.id)
      return updated
    })
    return c.json(bot)
  })
  app.post('/api/v1/bots/:id/copy', async (c) =>
    c.json(
      await store.update((state) => {
        const original = requireItem(state.bots[c.req.param('id')], 'Bot')
        if (Object.keys(state.bots).length >= 200) throw new BotError(409, 'limit-exceeded', '最多200个Bot')
        const copy = { ...original, ...resource(), name: `${original.name.slice(0, 75)} 副本`, enabled: false }
        delete copy.webConversationId
        state.bots[copy.id] = copy
        ensureBotConversation(state, copy.id)
        return copy
      }),
      201,
    ),
  )
  app.post('/api/v1/bots/:id/conversation', async (c) =>
    c.json(await store.update((state) => ensureBotConversation(state, c.req.param('id')))),
  )
  app.delete('/api/v1/bots/:id', async (c) => {
    const input = await body(c)
    await store.update((state) => {
      const bot = requireItem(state.bots[c.req.param('id')], 'Bot')
      revision(bot, input.revision)
      if (Object.values(state.tasks).some((task) => task.botId === bot.id && activeTask(task)))
        throw new BotError(409, 'active-tasks', '请先停止该角色的任务')
      if (
        Object.values(state.conversations).some(
          (conversation) =>
            !conversation.archived &&
            conversation.kind === 'group' &&
            conversation.memberIds.includes(bot.id) &&
            conversation.memberIds.filter((id) => id !== bot.id).length < 2,
        )
      )
        throw new BotError(409, 'resource-in-use', '删除后群组成员将少于2名Bot，请先处理群组成员或归档群组')
      if (
        state.qq.defaultBotId === bot.id ||
        Object.values(state.schedules).some((schedule) => schedule.botId === bot.id && schedule.enabled) ||
        Object.values(state.conversations).some(
          (conversation) =>
            !conversation.archived && conversation.kind !== 'direct' && conversation.coordinatorId === bot.id,
        )
      )
        throw new BotError(409, 'resource-in-use', '请先替换默认接待/协调者、暂停计划或归档关联会话')
      delete state.bots[bot.id]
      for (const conversation of Object.values(state.conversations))
        if (conversation.memberIds.includes(bot.id)) {
          if (conversation.archived && conversation.kind === 'group') continue
          if (conversation.kind === 'direct') conversation.archived = true
          else {
            conversation.memberIds = conversation.memberIds.filter((id) => id !== bot.id)
            delete conversation.memberSince[bot.id]
          }
          touch(conversation)
        }
    })
    return c.json({ deleted: true })
  })

  app.get('/api/v1/conversations', (c) => c.json({ items: Object.values(store.read().conversations) }))
  app.post('/api/v1/conversations', async (c) => {
    const input = await body(c)
    return c.json(
      await store.update((state) => {
        const conversation = conversationFields(input, state)
        if (conversation.kind === 'direct') return ensureBotConversation(state, conversation.coordinatorId)
        state.conversations[conversation.id] = conversation
        return conversation
      }),
      201,
    )
  })
  app.get('/api/v1/conversations/:id', (c) =>
    c.json(requireItem(store.read().conversations[c.req.param('id')], '会话')),
  )
  app.patch('/api/v1/conversations/:id', async (c) => {
    const input = await body(c)
    const existing = requireItem(store.read().conversations[c.req.param('id')], '会话')
    const removed = Array.isArray(input.memberIds)
      ? existing.memberIds.filter((id) => !(input.memberIds as string[]).includes(id))
      : []
    const running = Object.values(store.read().tasks).filter(
      (task) => task.conversationId === existing.id && removed.includes(task.botId) && activeTask(task),
    )
    if (running.length && input.removalMode !== 'stop')
      throw new BotError(409, 'active-tasks', '移除该成员前须明确停止当前任务', {
        taskIds: running.map((task) => task.id),
      })
    if (running.length) await Promise.all(running.map((task) => services.stopTask(task.id)))
    return c.json(
      await store.update((state) => {
        const current = requireItem(state.conversations[existing.id], '会话')
        revision(current, input.revision)
        if (input.archived === true && state.bots[current.coordinatorId]?.webConversationId === current.id)
          throw new BotError(409, 'fixed-conversation', 'Bot 的固定私聊不可归档；停用 Bot 可保留聊天记录')
        const archiveOnly =
          input.archived === true && Object.keys(input).every((key) => key === 'revision' || key === 'archived')
        if (
          archiveOnly &&
          Object.values(state.tasks).some((task) => task.conversationId === current.id && activeTask(task))
        )
          throw new BotError(409, 'active-tasks', '请先停止关联任务')
        // Archiving old records must remain possible even when a removed Bot made their membership invalid.
        const updated = archiveOnly ? { ...current, archived: true } : conversationFields(input, state, current)
        if (state.bots[current.coordinatorId]?.webConversationId === current.id)
          updated.name = state.bots[current.coordinatorId].name
        touch(updated)
        state.conversations[updated.id] = updated
        return updated
      }),
    )
  })
  app.delete('/api/v1/conversations/:id', async (c) => {
    const input = await body(c)
    await store.update((state) => {
      const conversation = requireItem(state.conversations[c.req.param('id')])
      revision(conversation, input.revision)
      if (state.bots[conversation.coordinatorId]?.webConversationId === conversation.id)
        throw new BotError(409, 'fixed-conversation', 'Bot 的固定私聊不可归档；停用 Bot 可保留聊天记录')
      if (Object.values(state.tasks).some((task) => task.conversationId === conversation.id && activeTask(task)))
        throw new BotError(409, 'active-tasks', '请先停止关联任务')
      conversation.archived = true
      touch(conversation)
    })
    return c.json({ archived: true })
  })
  app.get('/api/v1/conversations/:id/messages', (c) => {
    const state = store.read()
    const conversation = requireItem(state.conversations[c.req.param('id')], '会话')
    const limit = Number(c.req.query('limit') ?? 50)
    if (!Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new BotError(400, 'invalid-input', '分页大小须为1–200')
    let before = Infinity
    const cursor = c.req.query('cursor')
    if (cursor) {
      try {
        const value = JSON.parse(Buffer.from(cursor, 'base64url').toString())
        if (value.id !== conversation.id || value.epoch !== state.epoch || !Number.isInteger(value.before))
          throw new Error('游标不匹配')
        before = value.before
      } catch {
        throw new BotError(409, 'stale-cursor', '分页游标已失效，请重新读取会话')
      }
    }
    const all = Object.values(state.messages)
      .filter((message) => message.conversationId === conversation.id && message.sequence < before)
      .sort((a, b) => b.sequence - a.sequence)
    const items = all.slice(0, limit).reverse()
    const nextCursor =
      all.length > limit
        ? Buffer.from(JSON.stringify({ id: conversation.id, epoch: state.epoch, before: items[0].sequence })).toString(
            'base64url',
          )
        : undefined
    return c.json({ items, nextCursor })
  })
  app.post('/api/v1/conversations/:id/messages', async (c) => {
    const input = await body(c)
    return c.json(
      await services.acceptMessage({
        conversationId: c.req.param('id'),
        content: input.content as string,
        attachmentIds: input.attachmentIds as string[] | undefined,
        recipientIds: input.recipientIds as string[] | undefined,
        mode: input.mode as 'queue' | 'steer' | undefined,
        source: authenticate(c, store)?.kind === 'cookie' ? 'web' : 'api',
        requestId: `api:${hash(`${authenticate(c, store)!.id}:${c.req.path}:${c.req.header('Idempotency-Key')}`)}`,
      }),
      202,
    )
  })
  app.get('/api/v1/tasks', (c) =>
    c.json({
      items: snapshot(store.read()).tasks.filter(
        (task) => !c.req.query('conversationId') || task.conversationId === c.req.query('conversationId'),
      ),
    }),
  )
  app.get('/api/v1/tasks/:id', (c) =>
    c.json(
      requireItem(
        snapshot(store.read()).tasks.find((task) => task.id === c.req.param('id')),
        '任务',
      ),
    ),
  )
  app.post('/api/v1/tasks/:id/stop', async (c) => c.json(await services.stopTask(c.req.param('id'))))
  app.post('/api/v1/tasks/:id/attempts', async (c) => {
    const task = await runtime.retry(c.req.param('id'))
    delete task.modelConfig
    return c.json(task, 202)
  })

  app.get('/api/v1/settings/models', (c) => c.json({ models: snapshot(store.read()).models }))
  app.patch('/api/v1/settings/models', async (c) => {
    const input = await body(c)
    if (!Array.isArray(input.models) || input.models.length > 100)
      throw new BotError(400, 'invalid-input', '模型列表无效')
    const changes: { input: Record<string, unknown>; credentialRef?: string }[] = []
    try {
      for (const raw of input.models) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
          throw new BotError(400, 'invalid-input', '模型内容无效')
        const value = raw as Record<string, unknown>
        const apiKey = value.apiKey === undefined ? undefined : text(value.apiKey, 'API key', 8000, true)
        changes.push({ input: value, credentialRef: apiKey ? await store.writeSecret(apiKey) : undefined })
      }
      const models = await store.update((state) =>
        changes.map(({ input: value, credentialRef }) => {
          const old = typeof value.id === 'string' ? requireItem(state.models[value.id], '模型') : undefined
          if (old) revision(old, value.revision)
          const provider = value.provider ?? old?.provider ?? 'openai-compatible'
          const kind = value.kind ?? old?.kind ?? 'text'
          if (
            !['openai', 'openai-compatible', 'anthropic', 'google'].includes(String(provider)) ||
            !['text', 'image'].includes(String(kind))
          )
            throw new BotError(400, 'invalid-input', '模型供应商或类型无效')
          if (kind === 'image' && provider !== 'openai' && provider !== 'openai-compatible')
            throw new BotError(400, 'capability-unavailable', '图片模型目前支持OpenAI或兼容图片API')
          const defaultUrl =
            provider === 'anthropic'
              ? 'https://api.anthropic.com'
              : provider === 'google'
                ? 'https://generativelanguage.googleapis.com'
                : 'https://api.openai.com/v1'
          const baseUrl = text(value.baseUrl ?? old?.baseUrl ?? defaultUrl, '服务地址', 2000)
          let url: URL
          try {
            url = new URL(baseUrl)
          } catch {
            throw new BotError(400, 'invalid-input', '模型地址无效')
          }
          if (
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            (url.protocol !== 'https:' &&
              !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
          )
            throw new BotError(400, 'invalid-input', '远程模型须使用HTTPS；本机回环可用HTTP，地址不能包含凭据')
          const model: ModelConfig = {
            ...(old ?? resource()),
            name: text(value.name ?? old?.name, '模型名称', 80),
            kind: kind as ModelConfig['kind'],
            provider: provider as ModelConfig['provider'],
            model: text(value.model ?? old?.model, '模型ID', 200),
            baseUrl: baseUrl.replace(/\/$/, ''),
            credentialRef: value.apiKey === '' ? undefined : (credentialRef ?? old?.credentialRef),
          }
          if (old) touch(model)
          state.models[model.id] = model
          return removeSecret(model)
        }),
      )
      return c.json({ models })
    } catch (cause) {
      await Promise.all(changes.map((item) => store.deleteSecret(item.credentialRef)))
      throw cause
    }
  })
  app.delete('/api/v1/models/:id', async (c) => {
    const input = await body(c)
    await store.update((state) => {
      const model = requireItem(state.models[c.req.param('id')])
      revision(model, input.revision)
      if (Object.values(state.bots).some((bot) => bot.modelId === model.id))
        throw new BotError(409, 'resource-in-use', '请先为关联Bot更换模型')
      delete state.models[model.id]
    })
    return c.json({ deleted: true })
  })
  app.get('/api/v1/settings', (c) => c.json(store.read().settings))
  app.patch('/api/v1/settings', async (c) => {
    const input = await body(c)
    const settings = await store.update((state) => {
      for (const key of ['webEnabled', 'reducedMotion'] as const)
        if (input[key] !== undefined) {
          if (typeof input[key] !== 'boolean') throw new BotError(400, 'invalid-input', '设置值无效')
          state.settings[key] = input[key]
        }
      if (input.allowedWebDomains !== undefined) {
        const domains = ids(input.allowedWebDomains, '允许的域名', 100)
        if (
          domains.some(
            (domain) => !/^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)*[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(domain),
          )
        )
          throw new BotError(400, 'invalid-input', '域名无效')
        state.settings.allowedWebDomains = domains.map((domain) => domain.toLowerCase())
      }
      return state.settings
    })
    return c.json(settings)
  })

  app.get('/api/v1/memories', (c) => c.json({ items: Object.values(store.read().memories) }))
  const saveMemory = async (c: Context, existing: boolean) => {
    const input = await body(c)
    return c.json(
      await store.update((state) => {
        const old = existing ? requireItem(state.memories[c.req.param('id')!]) : undefined
        if (old) revision(old, input.revision)
        const value = { ...old, ...input }
        if (!['owner', 'bot', 'conversation'].includes(String(value.scope)))
          throw new BotError(400, 'invalid-input', '记忆范围无效')
        const targetId = value.scope === 'owner' ? undefined : text(value.targetId, '记忆目标', 128)
        if (value.scope === 'bot') requireItem(state.bots[targetId!], 'Bot')
        if (value.scope === 'conversation') requireItem(state.conversations[targetId!], '会话')
        if (value.sourceMessageId) {
          const source = requireItem(state.messages[text(value.sourceMessageId, '来源消息', 128)])
          if (value.scope === 'conversation' && source.conversationId !== targetId)
            throw new BotError(403, 'forbidden', '来源不属于该会话')
        }
        const memory: Memory = {
          ...(old ?? resource()),
          scope: value.scope as Memory['scope'],
          targetId,
          title: text(value.title, '标题', 120),
          content: text(value.content, '记忆内容', 16000),
          sourceMessageId: value.sourceMessageId as string | undefined,
        }
        if (old) touch(memory)
        state.memories[memory.id] = memory
        return memory
      }),
      existing ? 200 : 201,
    )
  }
  app.post('/api/v1/memories', (c) => saveMemory(c, false))
  app.patch('/api/v1/memories/:id', (c) => saveMemory(c, true))
  app.delete('/api/v1/memories/:id', async (c) => {
    const input = await body(c)
    await store.update((state) => {
      revision(requireItem(state.memories[c.req.param('id')]), input.revision)
      delete state.memories[c.req.param('id')]
    })
    return c.json({ deleted: true })
  })

  app.get('/api/v1/attachments', (c) => c.json({ items: Object.values(store.read().attachments) }))
  app.post('/api/v1/attachments', async (c) => {
    const form = await c.req.formData()
    const file = form.get('file')
    if (!(file instanceof File)) throw new BotError(400, 'invalid-input', '请选择上传文件')
    if (file.size > 20 * 1024 * 1024) throw new BotError(413, 'invalid-input', '文件不能超过20MiB')
    return c.json(
      await services.saveAttachment({
        name: file.name,
        mime: file.type || 'application/octet-stream',
        bytes: new Uint8Array(await file.arrayBuffer()),
        conversationId:
          typeof form.get('conversationId') === 'string' ? (form.get('conversationId') as string) : undefined,
        source: 'upload',
      }),
      201,
    )
  })
  app.get('/api/v1/attachments/:id', (c) => c.json(requireItem(store.read().attachments[c.req.param('id')], '附件')))
  app.get('/api/v1/attachments/:id/content', async (c) => {
    const attachment = requireItem(store.read().attachments[c.req.param('id')], '附件')
    const bytes = await services.readAttachment(attachment.id)
    const inline = /^image\/(?:png|jpeg|webp|gif)$/.test(attachment.mime)
    c.header('Content-Type', inline ? attachment.mime : 'application/octet-stream')
    c.header(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
    )
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Cache-Control', 'private, no-store')
    return c.body(bytes as Uint8Array<ArrayBuffer>)
  })
  app.post('/api/v1/attachments/:id/copy', async (c) => {
    const input = await body(c)
    const source = requireItem(store.read().attachments[c.req.param('id')], '附件')
    return c.json(
      await services.saveAttachment({
        name: source.name,
        mime: source.mime,
        bytes: await services.readAttachment(source.id),
        conversationId: text(input.conversationId, '目标会话', 128),
        source: 'upload',
      }),
      201,
    )
  })

  app.get('/api/v1/tokens', (c) => c.json({ items: snapshot(store.read()).tokens }))
  app.post('/api/v1/tokens', async (c) => {
    if (authenticate(c, store)?.kind !== 'cookie') throw new BotError(403, 'forbidden', '请在Web中管理API凭据')
    const input = await body(c)
    const raw = `pib_${randomBytes(32).toString('base64url')}`
    const token = await store.update((state) => {
      const scopes = ids(input.scopes ?? ['read', 'write'], '权限')
      if (!scopes.includes('read') || scopes.some((scope) => !['read', 'write'].includes(scope)))
        throw new BotError(400, 'invalid-input', 'API权限无效')
      const item = {
        ...resource(),
        name: text(input.name, '名称', 80),
        hash: hash(raw),
        prefix: raw.slice(0, 12),
        scopes: scopes as ('read' | 'write')[],
      }
      state.tokens[item.id] = item
      const { hash: _hash, ...publicItem } = item
      return publicItem
    })
    return c.json({ ...token, token: raw }, 201)
  })
  app.delete('/api/v1/tokens/:id', async (c) => {
    if (authenticate(c, store)?.kind !== 'cookie') throw new BotError(403, 'forbidden', '请在Web中撤销API凭据')
    await store.update((state) => {
      const token = requireItem(state.tokens[c.req.param('id')])
      token.revokedAt = new Date().toISOString()
      touch(token)
    })
    return c.json({ revoked: true })
  })
  app.get('/api/v1/events', (c) => {
    const value = c.req.header('Last-Event-ID') ?? c.req.query('after')
    const initial = store.read()
    let sequence = initial.seq
    if (value) {
      const index = value.lastIndexOf(':')
      const epoch = value.slice(0, index)
      const seq = Number(value.slice(index + 1))
      if (
        epoch !== initial.epoch ||
        !Number.isInteger(seq) ||
        seq < (initial.events[0]?.seq ?? 0) - 1 ||
        seq > initial.seq
      )
        throw new BotError(409, 'resync-required', '事件游标已过期，请重新读取快照')
      sequence = seq
    }
    return streamSSE(c, async (stream) => {
      while (!stream.aborted) {
        if (!authenticate(c, store)) {
          await stream.writeSSE({ event: 'unauthenticated', data: '{}' })
          break
        }
        const state = store.read()
        if (sequence < (state.events[0]?.seq ?? 0) - 1) {
          await stream.writeSSE({
            event: 'resync',
            data: JSON.stringify({ cursor: `${state.epoch}:${state.seq}`, resyncRequired: true }),
          })
          break
        }
        for (const event of state.events.filter((event) => event.seq > sequence)) {
          await stream.writeSSE({
            id: `${state.epoch}:${event.seq}`,
            event: 'change',
            data: JSON.stringify({ cursor: `${state.epoch}:${event.seq}`, event }),
          })
          sequence = event.seq
        }
        await stream.writeSSE({ event: 'heartbeat', data: JSON.stringify({ cursor: `${state.epoch}:${sequence}` }) })
        await stream.sleep(1000)
      }
    })
  })
}
