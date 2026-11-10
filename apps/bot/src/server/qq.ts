import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import WebSocket from 'ws'
import type { BotApp, BotServices, ChannelAdapter } from './contracts.js'
import type { Conversation, Delivery, Message, QqConfig, TaskResponse } from '../shared/types.js'
import { queueQqDeliveries } from './qq-outbox.js'
import { BotError } from './errors.js'

const api = 'https://api.sgroup.qq.com'
const digest = (value: string | Uint8Array, algorithm = 'sha256') => createHash(algorithm).update(value).digest('hex')
const now = () => new Date().toISOString()
function resource() {
  const time = now()
  return { id: randomUUID(), revision: 1, createdAt: time, updatedAt: time }
}
function touch(value: { revision: number; updatedAt: string }) {
  value.revision++
  value.updatedAt = now()
}
function configView(config: QqConfig) {
  const { credentialRef, bindingCodeHash: _hash, sessionId: _session, gatewaySequence: _sequence, ...value } = config
  return { ...value, hasCredential: !!credentialRef }
}
function required(value: unknown, label: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new BotError(400, 'invalid-input', `${label}不能为空且最多${max}字符`)
  return value.trim()
}
class QqRejection extends Error {}
interface GatewayEvent {
  op: number
  s?: number
  t?: string
  d?: Record<string, unknown>
}
interface IncomingMessage {
  id: string
  content?: string
  author: { user_openid?: string; bot?: boolean }
  msg_seq?: number
  message_scene?: { ext?: string[] }
  attachments?: { url: string; filename?: string; content_type?: string; size?: number }[]
}

async function readInput(request: { json: () => Promise<unknown> }): Promise<Record<string, unknown>> {
  const value = await request.json().catch(() => {
    throw new BotError(400, 'invalid-input', '请求体必须为 JSON 对象')
  })
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BotError(400, 'invalid-input', '请求体必须为 JSON 对象')
  return value as Record<string, unknown>
}

export function registerQqRoutes(app: BotApp, services: BotServices): ChannelAdapter {
  const { store } = services
  let socket: WebSocket | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let reconnect: ReturnType<typeof setTimeout> | undefined
  let flusher: ReturnType<typeof setInterval> | undefined
  let closed = false
  let flushing = false
  let connectionGeneration = 0
  let acknowledged = true
  let tokenCache: { token: string; expires: number; appId: string; ref: string } | undefined
  let eventQueue = Promise.resolve()
  async function setStatus(status: QqConfig['status'], error?: string) {
    await store.update((draft) => {
      draft.qq.status = status
      draft.qq.error = error
    })
  }
  function configured() {
    const config = store.read().qq
    if (!config.enabled || !config.appId || !config.credentialRef)
      throw new BotError(409, 'capability-unavailable', 'QQ 官方机器人尚未启用或未配置 AppID / AppSecret')
    return config
  }
  async function token(): Promise<string> {
    const config = configured()
    if (
      tokenCache?.appId === config.appId &&
      tokenCache.ref === config.credentialRef &&
      tokenCache.expires > Date.now() + 60000
    )
      return tokenCache.token
    const secret = await store.secret(config.credentialRef)
    if (!secret) throw new BotError(409, 'capability-unavailable', 'QQ AppSecret 不可用')
    const response = await fetch('https://bots.qq.com/app/getAppAccessToken', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: config.appId, clientSecret: secret }),
    })
    const body = (await response.json()) as { access_token?: string; expires_in?: number | string; code?: number }
    if (!response.ok || body.code || !body.access_token)
      throw new BotError(502, 'upstream-unavailable', 'QQ 官方凭据验证失败，请核对 AppID、密钥与账号权限')
    tokenCache = {
      token: body.access_token,
      expires: Date.now() + Number(body.expires_in ?? 7200) * 1000,
      appId: config.appId,
      ref: config.credentialRef!,
    }
    return tokenCache.token
  }
  async function apiRequest(path: string, body?: unknown, guard?: () => void): Promise<Record<string, unknown>> {
    const config = configured()
    const accessToken = await token()
    guard?.()
    const response = await fetch(`${api}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
      headers: {
        Authorization: `QQBot ${accessToken}`,
        'X-Union-Appid': config.appId,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const data = (await response.json()) as Record<string, unknown>
    if (!response.ok || (data.code !== undefined && data.code !== 0))
      throw new QqRejection(`QQ 平台拒绝请求（${typeof data.code === 'number' ? data.code : response.status}）`)
    return data
  }
  const request = apiRequest
  function disconnect() {
    connectionGeneration++
    if (heartbeat) clearInterval(heartbeat)
    if (reconnect) clearTimeout(reconnect)
    heartbeat = undefined
    reconnect = undefined
    socket?.removeAllListeners()
    socket?.close()
    socket = undefined
  }
  async function connect() {
    disconnect()
    if (closed) return
    const config = configured()
    const generation = connectionGeneration
    await setStatus('connecting')
    try {
      const gateway = await request('/gateway/bot')
      const url = new URL(String(gateway.url))
      if (url.protocol !== 'wss:' || !(url.hostname.endsWith('.qq.com') || url.hostname.endsWith('.sgroup.qq.com')))
        throw new Error('网关地址无效')
      if (generation !== connectionGeneration || closed) return
      socket = new WebSocket(url, { handshakeTimeout: 30000, maxPayload: 2 * 1024 * 1024 })
      const connection = socket
      connection.on('message', (raw) => {
        eventQueue = eventQueue
          .then(async () => {
            if (generation !== connectionGeneration) return
            const event = JSON.parse(raw.toString()) as GatewayEvent
            if (event.op === 10) {
              const interval = Number(event.d?.heartbeat_interval)
              if (!Number.isFinite(interval) || interval < 1000 || interval > 300000) throw new Error('QQ 心跳间隔无效')
              const accessToken = await token()
              const current = store.read().qq
              connection.send(
                JSON.stringify(
                  current.sessionId && current.gatewaySequence !== undefined
                    ? {
                        op: 6,
                        d: {
                          token: `QQBot ${accessToken}`,
                          session_id: current.sessionId,
                          seq: current.gatewaySequence,
                        },
                      }
                    : {
                        op: 2,
                        d: {
                          token: `QQBot ${accessToken}`,
                          intents: 1 << 25,
                          shard: [0, 1],
                          properties: { $os: process.platform, $browser: 'pi-meme-bots', $device: 'pi-meme-bots' },
                        },
                      },
                ),
              )
              acknowledged = true
              heartbeat = setInterval(() => {
                if (!acknowledged) {
                  connection.close()
                  return
                }
                acknowledged = false
                connection.send(JSON.stringify({ op: 1, d: store.read().qq.gatewaySequence ?? null }))
              }, interval)
            } else if (event.op === 11) acknowledged = true
            else if (event.op === 7) connection.close()
            else if (event.op === 9) {
              await store.update((draft) => {
                draft.qq.sessionId = undefined
                draft.qq.gatewaySequence = undefined
              })
              connection.close()
            } else if (event.op === 0) {
              if (event.t === 'READY')
                await store.update((draft) => {
                  draft.qq.sessionId = String(event.d?.session_id ?? '')
                  draft.qq.status = 'online'
                  draft.qq.error = undefined
                })
              else if (event.t === 'RESUMED') await setStatus('online')
              else if (event.t === 'C2C_MESSAGE_CREATE')
                await incoming(event.d as unknown as IncomingMessage, config.appId)
              await store.update((draft) => {
                if (draft.qq.appId === config.appId) {
                  draft.qq.gatewaySequence = event.s
                  draft.qq.lastEventAt = now()
                }
              })
            }
          })
          .catch(async () => {
            await setStatus('offline', 'QQ 事件处理失败，保留游标并等待官方重投')
            connection.close()
          })
      })
      connection.on('error', () => connection.close())
      connection.on('close', (code) => {
        if (heartbeat) clearInterval(heartbeat)
        heartbeat = undefined
        if (closed || generation !== connectionGeneration) return
        void setStatus('offline', `QQ 连接已断开（${code}）`).catch(() => undefined)
        if ([4001, 4002, 4010, 4011, 4012, 4013, 4014, 4914, 4915].includes(code)) return
        if ([4006, 4007].includes(code))
          void store
            .update((draft) => {
              draft.qq.sessionId = undefined
              draft.qq.gatewaySequence = undefined
            })
            .catch(() => undefined)
        reconnect = setTimeout(() => {
          void connect().catch(() => undefined)
        }, 5000)
      })
    } catch (error) {
      if (generation === connectionGeneration) await setStatus('offline', 'QQ 连接或认证失败，请核对凭据、权限和网络')
      throw error
    }
  }
  async function conversationFor(appId: string, userId: string): Promise<Conversation> {
    const state = store.read()
    const routeId = state.inboundIds[`qq-route:${appId}:${userId}`] ?? state.qq.defaultBotId
    const bot = [state.bots[routeId], state.bots[state.qq.defaultBotId], ...Object.values(state.bots)].find(
      (bot) => bot?.enabled,
    )
    if (!bot) throw new BotError(409, 'capability-unavailable', '当前 QQ 接待角色不可用，请在 Web 配置默认角色')
    const existing = Object.values(state.conversations).find(
      (c) => c.kind === 'qq' && c.qqAppId === appId && c.qqUserId === userId,
    )
    if (existing?.coordinatorId === bot.id) return existing
    return store.update((draft) => {
      if (draft.qq.appId !== appId || draft.qq.boundUserId !== userId || !draft.qq.enabled)
        throw new BotError(403, 'forbidden', 'QQ 绑定已失效')
      const duplicate = Object.values(draft.conversations).find(
        (c) => c.kind === 'qq' && c.qqAppId === appId && c.qqUserId === userId,
      )
      if (duplicate) {
        duplicate.coordinatorId = bot.id
        if (!duplicate.memberIds.includes(bot.id)) {
          duplicate.memberIds.push(bot.id)
          duplicate.memberSince[bot.id] = duplicate.sequence + 1
        }
        touch(duplicate)
        return duplicate
      }
      const conversation: Conversation = {
        ...resource(),
        name: 'QQ 私聊',
        kind: 'qq',
        memberIds: [bot.id],
        coordinatorId: bot.id,
        memberSince: { [bot.id]: 0 },
        pinned: false,
        archived: false,
        sequence: 0,
        qqAppId: appId,
        qqUserId: userId,
      }
      draft.conversations[conversation.id] = conversation
      return conversation
    })
  }
  async function reply(conversation: Conversation, platformMessageId: string, content: string, dedupe: string) {
    await store.update((draft) => {
      if (draft.inboundIds[dedupe]) return
      if (
        !draft.qq.enabled ||
        draft.qq.appId !== conversation.qqAppId ||
        draft.qq.boundUserId !== conversation.qqUserId
      )
        return
      const conv = draft.conversations[conversation.id]
      const message: Message = {
        ...resource(),
        conversationId: conv.id,
        sequence: ++conv.sequence,
        role: 'system',
        content,
        authorName: 'QQ',
        attachmentIds: [],
        source: 'qq',
      }
      draft.messages[message.id] = message
      draft.inboundIds[`qq-reply:${message.id}`] = platformMessageId
      queueQqDeliveries(draft, message)
      draft.inboundIds[dedupe] = message.id
      touch(conv)
    })
  }
  async function incoming(event: IncomingMessage, appId: string) {
    const userId = event?.author?.user_openid
    if (!userId || !event.id || event.author.bot || store.read().qq.appId !== appId) return
    const index = event.message_scene?.ext?.find((v) => v.startsWith('msg_idx='))?.slice(8)
    const key = `qq-in:${appId}:${userId}:${event.id}:${index ?? event.msg_seq ?? ''}`
    const requestId = `qq-input-${digest(key)}`
    const state = store.read()
    if (state.inboundIds[key]) return
    const previouslyAccepted = state.inboundIds[`input:${requestId}`]
    if (previouslyAccepted) {
      await store.update((draft) => {
        draft.inboundIds[key] = previouslyAccepted
        draft.inboundIds[`qq-reply:${previouslyAccepted}`] = event.id
      })
      return
    }
    const content = (event.content ?? '').trim()
    const config = store.read().qq
    if (!config.boundUserId) {
      const code = content.match(/^\/(?:绑定|bind)\s+([a-zA-Z0-9-]+)$/)?.[1]
      if (
        !code ||
        !config.bindingCodeHash ||
        !config.bindingExpiresAt ||
        Date.parse(config.bindingExpiresAt) < Date.now()
      )
        return
      const candidate = Buffer.from(digest(code))
      const expected = Buffer.from(config.bindingCodeHash)
      if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) return
      await store.update((draft) => {
        if (
          draft.qq.appId !== appId ||
          !draft.qq.enabled ||
          draft.qq.revision !== config.revision ||
          draft.qq.bindingCodeHash !== config.bindingCodeHash ||
          draft.qq.boundUserId ||
          Date.parse(draft.qq.bindingExpiresAt ?? '') < Date.now()
        )
          return
        draft.qq.boundUserId = userId
        draft.qq.bindingCodeHash = undefined
        draft.qq.bindingExpiresAt = undefined
        draft.qq.revision++
      })
      if (store.read().qq.boundUserId !== userId) return
      const conversation = await conversationFor(appId, userId)
      await reply(
        conversation,
        event.id,
        '账号绑定成功。发送 /角色 查看角色，/切换 角色名 切换，/状态 查看任务，/停止 停止当前任务。',
        key,
      )
      return
    }
    if (config.boundUserId !== userId) return
    let conversation = await conversationFor(appId, userId)
    const switchMatch = content.match(/^\/(?:切换|switch)\s+(\S.*)$/)
    if (switchMatch) {
      const matches = Object.values(store.read().bots).filter(
        (bot) => bot.enabled && (bot.id === switchMatch[1] || bot.name === switchMatch[1]),
      )
      if (matches.length !== 1) {
        await reply(conversation, event.id, '角色不存在或名称重名，请发送 /角色 并使用准确名称或 ID。', key)
        return
      }
      await store.update((draft) => {
        draft.inboundIds[`qq-route:${appId}:${userId}`] = matches[0].id
      })
      conversation = await conversationFor(appId, userId)
      await reply(conversation, event.id, `已切换至 ${matches[0].name}。其他角色的历史不会自动共享。`, key)
      return
    }
    if (/^\/(?:角色|bots)$/.test(content)) {
      await reply(
        conversation,
        event.id,
        Object.values(store.read().bots)
          .filter((bot) => bot.enabled)
          .map((bot) => `${bot.name} · ${bot.id}`)
          .join('\n') || '没有已启用的角色。',
        key,
      )
      return
    }
    if (/^\/(?:状态|status)$/.test(content)) {
      const tasks = Object.values(store.read().tasks)
        .filter((task) => task.conversationId === conversation.id && task.botId === conversation.coordinatorId)
        .slice(-8)
      await reply(
        conversation,
        event.id,
        tasks.map((task) => `${task.config.name} · ${task.status} · ${task.id}`).join('\n') || '当前角色没有任务。',
        key,
      )
      return
    }
    if (/^\/(?:停止|stop)$/.test(content)) {
      const tasks = Object.values(store.read().tasks).filter(
        (task) =>
          task.conversationId === conversation.id &&
          task.botId === conversation.coordinatorId &&
          ['queued', 'running', 'waiting', 'stopping'].includes(task.status),
      )
      for (const task of tasks.filter((task) => !task.parentTaskId)) await services.stopTask(task.id)
      await reply(
        conversation,
        event.id,
        tasks.length ? '已提交停止请求；Pi meme 任务以实际停止回执为准，可在 Web 查看。' : '没有进行中的任务。',
        key,
      )
      return
    }
    const pending = Object.values(store.read().tasks)
      .filter((task) => task.conversationId === conversation.id && ['running', 'waiting'].includes(task.status))
      .flatMap((task) =>
        (task.interactions ?? []).filter((item) => item.status === 'pending').map((item) => ({ task, item })),
      )
    const explicitReply = content.match(/^\/(?:回复|reply)\s+(\S+)\s+(\S[\s\S]*)$/)
    if (pending.length || explicitReply) {
      const target = explicitReply
        ? pending.find(({ item }) => item.id === explicitReply[1])
        : pending.length === 1
          ? pending[0]
          : undefined
      if (!target) {
        await reply(
          conversation,
          event.id,
          pending.length
            ? pending
                .map(({ task, item }) => `${task.config.name} · ${item.question}\n/回复 ${item.id} 答案`)
                .join('\n\n')
            : '这个问题已处理或已失效。',
          key,
        )
        return
      }
      const answer = (explicitReply?.[2] ?? content).trim()
      const { task, item } = target
      const response: TaskResponse = { interactionId: item.id, revision: item.revision }
      if (item.kind === 'confirmation') {
        const decision = answer.toLowerCase().replace(/[。！!.]$/, '')
        if (['确认', '确定', '同意', '允许', '是', '继续', 'yes', 'confirm', 'approve'].includes(decision))
          response.decision = 'approve'
        else if (['取消', '拒绝', '否', '不同意', '不用了', 'no', 'cancel', 'deny'].includes(decision))
          response.decision = 'deny'
        else {
          await reply(conversation, event.id, `${item.question}\n请回复“确认”或“取消”。`, key)
          return
        }
      } else if (item.options?.length) {
        const option = item.options.find(
          (option, index) => option.label === answer || option.value === answer || String(index + 1) === answer,
        )
        if (!option) {
          await reply(
            conversation,
            event.id,
            `${item.question}\n${item.options.map((option, index) => `${index + 1}. ${option.label}`).join('\n')}\n请回复选项名称或序号。`,
            key,
          )
          return
        }
        response.answer = option.value
      } else response.answer = answer
      try {
        await services.respondToTask(task.id, response, requestId, {
          appId,
          userId,
          inboundKey: key,
          platformMessageId: event.id,
        })
      } catch (cause) {
        if (!(cause instanceof BotError) || cause.status >= 500) throw cause
        await reply(conversation, event.id, cause.message, key)
      }
      return
    }
    const attachmentIds: string[] = []
    if ((event.attachments?.length ?? 0) > 8) {
      await reply(conversation, event.id, '单条消息最多支持 8 个附件，请拆分发送或在 Web 上传。', key)
      return
    }
    for (const attachment of event.attachments ?? []) {
      let url: URL
      try {
        url = new URL(attachment.url)
      } catch {
        await reply(conversation, event.id, 'QQ 附件地址无效，请在 Web 上传。', key)
        return
      }
      if (
        url.protocol !== 'https:' ||
        !['.qq.com', '.qpic.cn', '.gtimg.cn', '.myqcloud.com'].some((suffix) => url.hostname.endsWith(suffix))
      ) {
        await reply(conversation, event.id, '该附件地址不属于支持的 QQ 官方媒体域，请在 Web 上传。', key)
        return
      }
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) })
      if (!response.ok || Number(response.headers.get('content-length')) > 20 * 1024 * 1024) {
        await reply(conversation, event.id, '附件不可下载或超过 20 MiB，请在 Web 处理。', key)
        return
      }
      const reader = response.body?.getReader()
      if (!reader) throw new Error('QQ 附件没有正文')
      const chunks: Uint8Array[] = []
      let size = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 20 * 1024 * 1024) {
          await reader.cancel()
          throw new Error('QQ 附件超限')
        }
        chunks.push(value)
      }
      const saved = await services.saveAttachment({
        name: attachment.filename || 'QQ 附件',
        mime: attachment.content_type || 'application/octet-stream',
        bytes: Buffer.concat(chunks),
        conversationId: conversation.id,
        source: 'upload',
      })
      attachmentIds.push(saved.id)
    }
    if (!content && !attachmentIds.length) {
      await reply(conversation, event.id, '当前只支持文字和可下载附件，请在 Web 查看其他内容。', key)
      return
    }
    const currentBinding = store.read().qq
    if (!currentBinding.enabled || currentBinding.appId !== appId || currentBinding.boundUserId !== userId) return
    const accepted = await services.acceptMessage({
      conversationId: conversation.id,
      content: content || '请查看附件。',
      attachmentIds,
      source: 'qq',
      requestId,
      platformMessageId: event.id,
      recipientIds: [conversation.coordinatorId],
    })
    await store.update((draft) => {
      draft.inboundIds[key] = accepted.messageId
      draft.inboundIds[`qq-reply:${accepted.messageId}`] = event.id
      if (draft.messages[accepted.messageId]) draft.messages[accepted.messageId].platformMessageId = event.id
    })
  }
  async function upload(delivery: Delivery, guard: () => void): Promise<string> {
    const request = (path: string, body?: unknown) => apiRequest(path, body, guard)
    guard()
    if (delivery.mediaInfo && (!delivery.mediaExpiresAt || Date.parse(delivery.mediaExpiresAt) > Date.now()))
      return delivery.mediaInfo
    const attachment = store.read().attachments[delivery.attachmentId!]
    if (!attachment) throw new QqRejection('附件不存在，结果仍可在 Web 中核对')
    const bytes = await services.readAttachment(attachment.id)
    if (!bytes.byteLength || bytes.byteLength > 200 * 1024 * 1024)
      throw new QqRejection('附件为空或超过 QQ 200 MiB 限制')
    const fileType = attachment.mime.startsWith('image/')
      ? 1
      : attachment.mime === 'video/mp4'
        ? 2
        : attachment.mime.startsWith('audio/')
          ? 3
          : 4
    const path = `/v2/users/${encodeURIComponent(delivery.targetUserId)}`
    let media: Record<string, unknown>
    if (bytes.byteLength <= 5 * 1024 * 1024)
      media = await request(`${path}/files`, {
        file_type: fileType,
        file_name: attachment.name,
        file_data: Buffer.from(bytes).toString('base64'),
        srv_send_msg: false,
      })
    else {
      const prepared = await request(`${path}/upload_prepare`, {
        file_type: fileType,
        file_size: String(bytes.byteLength),
        file_name: attachment.name,
        md5: digest(bytes, 'md5'),
        sha1: digest(bytes, 'sha1'),
        md5_10m: digest(bytes.subarray(0, 10002432), 'md5'),
      })
      const blockSize = Number(prepared.block_size)
      const parts = prepared.parts as { index: number; presigned_url: string; block_size: string }[]
      if (
        !prepared.upload_id ||
        !Number.isSafeInteger(blockSize) ||
        blockSize < 1 ||
        !Array.isArray(parts) ||
        parts.length !== Math.ceil(bytes.byteLength / blockSize)
      )
        throw new Error('QQ 分片参数无效')
      for (const [index, part] of parts.entries()) {
        if (part.index !== index) throw new Error('QQ 分片顺序无效')
        const url = new URL(part.presigned_url)
        if (
          url.protocol !== 'https:' ||
          !['.myqcloud.com', '.qq.com', '.qcloud.com'].some((suffix) => url.hostname.endsWith(suffix))
        )
          throw new Error('QQ 分片上传地址无效')
        const chunk = bytes.subarray(index * blockSize, Math.min(bytes.byteLength, (index + 1) * blockSize))
        guard()
        const response = await fetch(url, {
          method: 'PUT',
          redirect: 'error',
          signal: AbortSignal.timeout(60000),
          body: Buffer.from(chunk),
        })
        if (!response.ok) throw new Error('QQ 分片上传失败')
        await request(`${path}/upload_part_finish`, {
          upload_id: prepared.upload_id,
          part_index: index,
          block_size: String(chunk.byteLength),
          md5: digest(chunk, 'md5'),
        })
      }
      media = await request(`${path}/files`, {
        upload_id: prepared.upload_id,
        file_type: fileType,
        file_name: attachment.name,
        srv_send_msg: false,
      })
    }
    if (typeof media.file_info !== 'string') throw new Error('QQ 上传未返回 file_info')
    await store.update((draft) => {
      const current = draft.deliveries[delivery.id]
      current.mediaInfo = media.file_info as string
      current.mediaExpiresAt =
        Number(media.ttl) > 0 ? new Date(Date.now() + Number(media.ttl) * 1000).toISOString() : undefined
      touch(current)
    })
    return media.file_info
  }
  const adapter: ChannelAdapter = {
    async start() {
      closed = false
      await store.update((draft) => {
        for (const delivery of Object.values(draft.deliveries))
          if (delivery.status === 'sending') {
            delivery.status = 'unknown'
            delivery.error = '进程在发送期间中断，平台结果未知，不会自动重发'
            touch(delivery)
          }
      })
      if (store.read().qq.enabled) await connect().catch(() => undefined)
      else await setStatus('disabled', store.read().qq.credentialRef ? undefined : '尚未配置 QQ 官方机器人凭据')
      flusher = setInterval(() => {
        void adapter.flush().catch(() => undefined)
      }, 2000)
    },
    async flush() {
      if (closed || flushing) return
      flushing = true
      try {
        const snapshot = store.read()
        const unqueued = Object.values(snapshot.messages).filter((message) => {
          const conversation = snapshot.conversations[message.conversationId]
          if (conversation?.kind !== 'qq' || message.source !== 'qq' || message.role === 'user') return false
          const count = (message.content ? 1 : 0) + message.attachmentIds.length
          return Array.from({ length: count }, (_, index) => `qq-${message.id}-${index}`).some(
            (id) => !snapshot.deliveries[id],
          )
        })
        if (unqueued.length)
          await store.update((draft) => {
            for (const message of unqueued) queueQqDeliveries(draft, message)
          })
        for (const pending of Object.values(store.read().deliveries).filter(
          (delivery) => delivery.status === 'pending',
        )) {
          const config = store.read().qq
          if (
            !config.enabled ||
            !config.credentialRef ||
            config.appId !== pending.appId ||
            config.boundUserId !== pending.targetUserId
          ) {
            await store.update((draft) => {
              const current = draft.deliveries[pending.id]
              current.status = 'blocked'
              current.error = 'QQ 未配置、已停用或目标账号已解绑'
              touch(current)
            })
            continue
          }
          const guard = () => {
            const current = store.read().qq
            if (
              closed ||
              !current.enabled ||
              current.revision !== config.revision ||
              current.credentialRef !== config.credentialRef ||
              current.appId !== pending.appId ||
              current.boundUserId !== pending.targetUserId
            )
              throw new QqRejection('QQ 配置或账号授权已改变，已阻止新的外发')
          }
          const message = store.read().messages[pending.messageId]
          if (!message) continue
          await store.update((draft) => {
            const current = draft.deliveries[pending.id]
            if (current.status !== 'pending') return
            current.status = 'sending'
            current.attempts++
            touch(current)
          })
          try {
            const content = `${message.role === 'assistant' ? `${message.authorName}：\n` : ''}${message.content}`
            if (!pending.attachmentId && content.length > 4000)
              throw new QqRejection('正文超过 QQ 单条限制，完整结果保留在 Web；不会截断或自动群发')
            const mediaInfo = pending.attachmentId ? await upload(pending, guard) : undefined
            const response = await request(
              `/v2/users/${encodeURIComponent(pending.targetUserId)}/messages`,
              {
                msg_type: mediaInfo ? 7 : 0,
                ...(mediaInfo ? { media: { file_info: mediaInfo } } : { content }),
                ...(pending.replyMessageId ? { msg_id: pending.replyMessageId, msg_seq: pending.replySequence } : {}),
              },
              guard,
            )
            if (typeof response.id !== 'string') throw new Error('QQ 未返回消息回执')
            await store.update((draft) => {
              const delivery = draft.deliveries[pending.id]
              delivery.status = 'sent'
              delivery.platformMessageId = response.id as string
              delivery.error = undefined
              touch(delivery)
            })
          } catch (error) {
            await store.update((draft) => {
              const delivery = draft.deliveries[pending.id]
              delivery.status = error instanceof QqRejection ? 'failed' : 'unknown'
              delivery.error =
                error instanceof QqRejection ? error.message : 'QQ 发送结果未知，禁止自动重发；原结果保留在 Web'
              touch(delivery)
            })
          }
        }
      } finally {
        flushing = false
      }
    },
    async close() {
      closed = true
      disconnect()
      if (flusher) clearInterval(flusher)
      await eventQueue.catch(() => undefined)
      await setStatus(store.read().qq.enabled ? 'offline' : 'disabled')
    },
  }
  app.get('/api/v1/channels/qq', (c) => c.json(configView(store.read().qq)))
  app.patch('/api/v1/channels/qq', async (c) => {
    const input = await readInput(c.req)
    if (Object.keys(input).some((key) => !['revision', 'enabled', 'appId', 'appSecret', 'defaultBotId'].includes(key)))
      throw new BotError(400, 'invalid-input', 'QQ 配置字段无效')
    const state = store.read()
    const old = state.qq
    if (input.revision !== old.revision)
      throw new BotError(409, 'revision-conflict', 'QQ 配置已修改', { revision: old.revision })
    const appId = input.appId === undefined ? old.appId : required(input.appId, 'AppID', 128)
    const defaultBotId =
      input.defaultBotId === undefined
        ? old.defaultBotId ||
          state.modelSettings.defaultAssistantId ||
          Object.values(state.bots).find((bot) => bot.enabled)?.id ||
          ''
        : required(input.defaultBotId, '默认 Bot')
    if (!state.bots[defaultBotId]?.enabled) throw new BotError(400, 'invalid-input', '默认接待 Bot 不存在或未启用')
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean')
      throw new BotError(400, 'invalid-input', 'enabled 必须为布尔值')
    const enabled = input.enabled === undefined ? (old.appId ? old.enabled : true) : input.enabled
    const credentialRef =
      input.appSecret === undefined
        ? old.credentialRef
        : await store.writeSecret(required(input.appSecret, 'AppSecret', 8192))
    let committed = false
    try {
      if (enabled && (!appId || !credentialRef)) throw new BotError(400, 'invalid-input', '请输入 AppID 和 AppSecret')
      await store.update((draft) => {
        if (draft.qq.revision !== input.revision) throw new BotError(409, 'revision-conflict', 'QQ 配置已修改')
        if (!draft.bots[defaultBotId]?.enabled) throw new BotError(409, 'conflict', '默认接待 Bot 已停用')
        draft.qq = {
          ...draft.qq,
          revision: old.revision + 1,
          appId,
          defaultBotId,
          enabled,
          credentialRef,
          status: enabled ? 'connecting' : 'disabled',
          error: undefined,
          sessionId: undefined,
          gatewaySequence: undefined,
          ...(appId !== old.appId
            ? { boundUserId: undefined, bindingCodeHash: undefined, bindingExpiresAt: undefined }
            : {}),
        }
      })
      committed = true
    } finally {
      if (!committed && old.credentialRef !== credentialRef) await store.deleteSecret(credentialRef)
    }
    disconnect()
    tokenCache = undefined
    if (old.credentialRef !== credentialRef) await store.deleteSecret(old.credentialRef)
    if (enabled)
      await connect().catch((cause: unknown) => {
        if (c.req.raw.signal.aborted) throw cause
      })
    return c.json(configView(store.read().qq))
  })
  app.post('/api/v1/channels/qq/connect', async (c) => {
    configured()
    await connect()
    return c.json(configView(store.read().qq))
  })
  app.post('/api/v1/channels/qq/binding', async (c) => {
    configured()
    const input = await readInput(c.req).catch((): Record<string, unknown> => ({}))
    const config = store.read().qq
    if (input.revision !== undefined && input.revision !== config.revision)
      throw new BotError(409, 'revision-conflict', 'QQ 配置已修改')
    if (config.boundUserId) throw new BotError(409, 'conflict', '已有绑定账号，请先显式解绑')
    const code = randomBytes(12).toString('hex')
    const expiresAt = new Date(Date.now() + 5 * 60000).toISOString()
    await store.update((draft) => {
      if (draft.qq.revision !== config.revision || draft.qq.boundUserId)
        throw new BotError(409, 'revision-conflict', 'QQ 配置已修改，请重新生成绑定码')
      draft.qq.bindingCodeHash = digest(code)
      draft.qq.bindingExpiresAt = expiresAt
      draft.qq.revision++
    })
    return c.json({ code, expiresAt })
  })
  app.delete('/api/v1/channels/qq/binding', async (c) => {
    const input = await readInput(c.req)
    await store.update((draft) => {
      if (input.revision !== draft.qq.revision) throw new BotError(409, 'revision-conflict', 'QQ 配置已修改')
      draft.qq.boundUserId = undefined
      draft.qq.bindingCodeHash = undefined
      draft.qq.bindingExpiresAt = undefined
      draft.qq.revision++
      for (const delivery of Object.values(draft.deliveries))
        if (delivery.status === 'pending') {
          delivery.status = 'blocked'
          delivery.error = 'QQ 账号已解绑'
          touch(delivery)
        }
    })
    return c.json(configView(store.read().qq))
  })
  app.get('/api/v1/deliveries', (c) => c.json(Object.values(store.read().deliveries)))
  app.post('/api/v1/deliveries/:id/attempts', async (c) => {
    const id = c.req.param('id')
    const input = await readInput(c.req).catch((): Record<string, unknown> => ({}))
    const old = store.read().deliveries[id]
    if (!old) throw new BotError(404, 'not-found', '投递记录不存在')
    if (!['failed', 'unknown', 'blocked'].includes(old.status))
      throw new BotError(409, 'conflict', '该投递尚在进行或已经成功')
    if (old.status === 'unknown' && input.confirmUnknown !== true)
      throw new BotError(409, 'outcome-unknown', '平台可能已收到消息；确认潜在重复后才能创建新投递尝试')
    const config = configured()
    if (config.boundUserId !== old.targetUserId || config.appId !== old.appId)
      throw new BotError(403, 'forbidden', '该投递的 QQ 身份已失效')
    const attempt = await store.update((draft) => {
      const used = Object.values(draft.deliveries).filter(
        (item) =>
          old.replyMessageId &&
          item.replyMessageId === old.replyMessageId &&
          item.appId === old.appId &&
          item.targetUserId === old.targetUserId,
      ).length
      if (old.replyMessageId && used >= 4)
        throw new BotError(409, 'capability-unavailable', '该被动消息回复额度已用尽，请在 QQ 发送新消息后处理')
      const next: Delivery = {
        ...old,
        ...resource(),
        status: 'pending',
        attempts: 0,
        platformMessageId: undefined,
        error: undefined,
        replySequence: used + 1,
      }
      draft.deliveries[next.id] = next
      return next
    })
    return c.json(attempt, 201)
  })
  return adapter
}
