import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { streamSSE } from 'hono/streaming'
import type { Context } from 'hono'
import type { AppState, Snapshot, TaskResponse } from '../shared/types.js'
import type { BotApp, BotServices } from './contracts.js'
import { authenticate, changeOwnerPassword, hash } from './auth.js'
import { BotError, ids, requireItem, revision, text, touch } from './errors.js'
import type { BotRuntime } from './runtime.js'
import { activeTask } from './runtime.js'
import { ensureBotConversation } from './bot-conversations.js'
import { botFields, botView } from './bot-fields.js'
import {
  deleteModel,
  fallbackDefaultAssistant,
  modelSettingsView,
  patchModelSettings,
  resolveBotModel,
} from './model-settings.js'
import { imageMimeTypes, readableAttachment } from '../shared/attachment-types.js'
import { checkModelSettings } from './model-check.js'
import {
  archiveConversation,
  conversationFields,
  createBot,
  createConversation,
  deleteBot,
  saveMemory,
  validateBotRemoval,
  validateConversationArchive,
} from './domain-mutations.js'
import { assertTaskAuthorized } from './task-interactions.js'

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
  const modelSettings = modelSettingsView(state)
  const textAvailable = Object.values(state.models).some((model) => {
    try {
      resolveBotModel(state, model.id)
      return true
    } catch {
      return false
    }
  })
  const imagesAvailable = modelSettings.models.some((model) => model.kind === 'image' && model.hasCredential)
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
    bots: Object.values(state.bots).map((bot) => botView(state, bot)),
    models: modelSettings.models,
    modelSettings,
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
        reason: textAvailable ? undefined : '请配置并验证支持工具调用的对话模型',
      },
      images: { available: imagesAvailable, reason: imagesAvailable ? undefined : '请配置图片模型及凭据' },
      web: {
        available: state.settings.webEnabled,
        reason: state.settings.webEnabled ? '支持公开网页，不包含登录态浏览' : '尚未启用公开网页探索',
      },
      hosts: {
        available: Object.values(state.hosts).some((host) => host.status === 'online'),
        reason: '提供 Pi meme 的 URL 和密钥即可连接',
      },
      qq: { available: state.qq.status === 'online', reason: state.qq.error ?? '需要官方机器人凭据和本人绑定' },
      schedules: { available: true },
    },
  }
}

function validImageHeader(bytes: Buffer, mime: string): boolean {
  switch (mime) {
    case 'image/png':
      return (
        bytes.length >= 33 &&
        bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
        bytes.toString('ascii', 12, 16) === 'IHDR' &&
        bytes.readUInt32BE(16) > 0 &&
        bytes.readUInt32BE(20) > 0
      )
    case 'image/jpeg':
      return bytes.length > 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    case 'image/webp':
      return bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
    case 'image/gif':
      return (
        bytes.length >= 13 &&
        ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6)) &&
        bytes.readUInt16LE(6) > 0 &&
        bytes.readUInt16LE(8) > 0
      )
    default:
      return false
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
      if (input.source === 'upload') {
        if (!readableAttachment(mime))
          throw new BotError(400, 'unsupported-attachment', '支持 PNG、JPEG、WebP、GIF、UTF-8 文本和 JSON')
        if (imageMimeTypes.includes(mime)) {
          if (!validImageHeader(Buffer.from(input.bytes), mime))
            throw new BotError(400, 'invalid-attachment', '图片内容与声明的文件类型不符或已经损坏')
        } else {
          try {
            new TextDecoder('utf-8', { fatal: true }).decode(input.bytes)
          } catch {
            throw new BotError(400, 'invalid-attachment', '文本附件须使用有效的 UTF-8 编码')
          }
        }
      }
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
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
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
  app.get('/api/v1/snapshot', (c) => c.json({ ...snapshot(store.read()), live: runtime.liveSnapshot() }))
  app.get('/api/v1/capabilities', (c) => c.json(snapshot(store.read()).capabilities))
  app.get('/api/v1/bots', (c) => {
    const state = store.read()
    return c.json({ items: Object.values(state.bots).map((bot) => botView(state, bot)) })
  })
  app.get('/api/v1/bots/:id', (c) => {
    const state = store.read()
    return c.json(botView(state, requireItem(state.bots[c.req.param('id')], 'Bot')))
  })
  app.post('/api/v1/bots', async (c) => {
    const input = await body(c)
    return c.json(await store.update((state) => botView(state, createBot(state, input))), 201)
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
      if (!updated.enabled) fallbackDefaultAssistant(state, updated.id)
      if (input.enabled === false && input.runningTasks === 'finish')
        for (const task of Object.values(state.tasks))
          if (task.botId === updated.id && activeTask(task)) task.finishOnDisable = true
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
        const copy = {
          ...original,
          ...resource(),
          conversationId: randomUUID(),
          name: `${original.name.slice(0, 75)} 副本`,
          enabled: false,
        }
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
    await store.update((state) => deleteBot(state, c.req.param('id'), input.revision))
    return c.json({ deleted: true })
  })

  app.get('/api/v1/conversations', (c) => c.json({ items: Object.values(store.read().conversations) }))
  app.post('/api/v1/conversations', async (c) => {
    const input = await body(c)
    return c.json(await store.update((state) => createConversation(state, input)), 201)
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
        if (input.archived === true && state.bots[current.coordinatorId]?.conversationId === current.id)
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
        if (state.bots[current.coordinatorId]?.conversationId === current.id)
          updated.name = state.bots[current.coordinatorId].name
        touch(updated)
        state.conversations[updated.id] = updated
        return updated
      }),
    )
  })
  app.delete('/api/v1/conversations/:id', async (c) => {
    const input = await body(c)
    await store.update((state) => archiveConversation(state, c.req.param('id'), input.revision))
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
        targetTaskId: input.targetTaskId as string | undefined,
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
  app.post('/api/v1/tasks/:id/completion-action', async (c) => {
    const input = await body(c)
    if (
      Object.keys(input).some((key) => !['kind', 'revision'].includes(key)) ||
      !['delete-bot', 'archive-conversation'].includes(String(input.kind))
    )
      throw new BotError(400, 'invalid-input', '回复后的配置操作无效')
    const action = await store.update((state) => {
      const task = requireItem(state.tasks[c.req.param('id')], '任务')
      assertTaskAuthorized(state, task)
      if (c.get('configurationTaskId') && c.get('configurationTaskId') !== task.id)
        throw new BotError(403, 'forbidden', '配置操作须绑定发起任务')
      if (task.completionAction) throw new BotError(409, 'conflict', '本轮已安排回复后的配置操作')
      const target =
        input.kind === 'delete-bot'
          ? validateBotRemoval(state, task.botId, input.revision, task.id)
          : validateConversationArchive(state, task.conversationId, input.revision, task.id)
      task.completionAction = {
        kind: input.kind as 'delete-bot' | 'archive-conversation',
        targetId: target.id,
        revision: target.revision,
        status: 'pending',
      }
      touch(task)
      return task.completionAction
    })
    return c.json({ action, applyAfterReply: true })
  })
  app.post('/api/v1/tasks/:id/stop', async (c) => c.json(await services.stopTask(c.req.param('id'))))
  app.post('/api/v1/tasks/:id/responses', async (c) => {
    const requestId = hash(`${authenticate(c, store)!.id}:${c.req.path}:${c.req.header('Idempotency-Key')}`)
    const task = await runtime.respond(c.req.param('id'), (await body(c)) as unknown as TaskResponse, requestId)
    const { modelConfig: _modelConfig, ...publicTask } = task
    return c.json(publicTask)
  })
  app.post('/api/v1/tasks/:id/attempts', async (c) => {
    const task = await runtime.retry(c.req.param('id'))
    delete task.modelConfig
    return c.json(task, 202)
  })

  app.get('/api/v1/settings/models', (c) => c.json(modelSettingsView(store.read())))
  app.patch('/api/v1/settings/models', async (c) => c.json(await patchModelSettings(store, await body(c))))
  app.post('/api/v1/settings/models/check', async (c) =>
    c.json(await checkModelSettings(store, await body(c), c.req.raw.signal)),
  )
  app.delete('/api/v1/models/:id', async (c) => {
    const input = await body(c)
    await deleteModel(store, c.req.param('id'), input.revision)
    return c.json({ deleted: true })
  })
  app.post('/api/v1/settings/password', async (c) => {
    await changeOwnerPassword(store, await body(c))
    return c.json({ updated: true, signInRequired: true })
  })
  app.get('/api/v1/settings', (c) => c.json(store.read().settings))
  app.patch('/api/v1/settings', async (c) => {
    const input = await body(c)
    const settings = await store.update((state) => {
      if (
        Object.keys(input).some(
          (key) => !['theme', 'timezone', 'webEnabled', 'reducedMotion', 'allowedWebDomains'].includes(key),
        )
      )
        throw new BotError(400, 'invalid-input', '设置字段无效')
      if (input.theme !== undefined) {
        if (!['system', 'light', 'dark'].includes(String(input.theme)))
          throw new BotError(400, 'invalid-input', '主题须为跟随系统、浅色或深色')
        state.settings.theme = input.theme as AppState['settings']['theme']
      }
      if (input.timezone !== undefined) {
        const timezone = text(input.timezone, '时区', 100)
        try {
          new Intl.DateTimeFormat('zh-CN', { timeZone: timezone }).format()
        } catch {
          throw new BotError(400, 'invalid-input', '时区无效，请使用 IANA 时区名称')
        }
        state.settings.timezone = timezone
      }
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
  const saveMemoryRoute = async (c: Context, existing: boolean) => {
    const input = await body(c)
    return c.json(
      await store.update((state) =>
        saveMemory(state, input, existing ? requireItem(state.memories[c.req.param('id')!], '记忆') : undefined),
      ),
      existing ? 200 : 201,
    )
  }
  app.post('/api/v1/memories', (c) => saveMemoryRoute(c, false))
  app.patch('/api/v1/memories/:id', (c) => saveMemoryRoute(c, true))
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
    if (!c.get('configurationTaskId') && authenticate(c, store)?.kind !== 'cookie')
      throw new BotError(403, 'forbidden', '请登录后管理 API 凭据')
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
    if (!c.get('configurationTaskId') && authenticate(c, store)?.kind !== 'cookie')
      throw new BotError(403, 'forbidden', '请登录后撤销 API 凭据')
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
    const conversationId = c.req.query('conversationId')
    if (conversationId) requireItem(initial.conversations[conversationId], '会话')
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
      let liveVersion = 0
      let sentLiveVersion = -1
      let wake: (() => void) | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      const unsubscribe = runtime.subscribeLive(() => {
        liveVersion++
        wake?.()
      })
      stream.onAbort(() => wake?.())
      try {
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
          if (sentLiveVersion !== liveVersion) {
            const version = liveVersion
            await stream.writeSSE({ event: 'live', data: JSON.stringify(runtime.liveSnapshot(conversationId)) })
            sentLiveVersion = version
          }
          await stream.writeSSE({ event: 'heartbeat', data: JSON.stringify({ cursor: `${state.epoch}:${sequence}` }) })
          if (sentLiveVersion !== liveVersion) continue
          await new Promise<void>((resolve) => {
            wake = resolve
            timer = setTimeout(resolve, 1000)
          })
          clearTimeout(timer)
          wake = undefined
        }
      } finally {
        unsubscribe()
        clearTimeout(timer)
        wake = undefined
      }
    })
  })
}
