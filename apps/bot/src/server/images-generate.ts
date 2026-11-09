import { randomUUID } from 'node:crypto'
import type { AppState, Generation } from '../shared/types.js'
import type { BotServices } from './contracts.js'
import { BotError } from './errors.js'
import { getPublicResource } from './web-public.js'

const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_RESPONSE_BYTES = 30 * 1024 * 1024

function imageMime(bytes: Uint8Array) {
  if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString() === 'RIFF' &&
    Buffer.from(bytes.subarray(8, 12)).toString() === 'WEBP'
  )
    return 'image/webp'
  throw new BotError(502, 'upstream-unavailable', '供应商返回的内容不是受支持的 PNG、JPEG 或 WebP 图片')
}

async function readBounded(response: Response) {
  if (!response.body || Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES)
    throw new BotError(502, 'upstream-unavailable', '图片响应为空或超过大小限制')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > MAX_RESPONSE_BYTES) throw new BotError(502, 'upstream-unavailable', '图片响应超过大小限制')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  return Buffer.concat(chunks).toString('utf8')
}

function endpoint(baseUrl: string) {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    throw new BotError(400, 'invalid-input', '图片模型地址无效')
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
  )
    throw new BotError(400, 'invalid-input', '图片模型地址必须是 HTTPS，或本机 HTTP，且不含账号、查询与片段')
  url.pathname = `${url.pathname.replace(/\/$/, '')}/images/generations`
  return url.toString()
}

export function createImageGenerator(services: BotServices, shutdown: AbortSignal) {
  return async (
    input: {
      prompt: string
      conversationId: string
      taskId?: string
      modelId?: string
      previousGenerationId?: string
      confirmUnknown?: boolean
    },
    callerSignal?: AbortSignal,
  ) => {
    if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 16_000)
      throw new BotError(400, 'invalid-input', '图片提示词须为 1–16000 字符')
    const state = services.store.read()
    const conversation = state.conversations[input.conversationId]
    if (!conversation || conversation.archived) throw new BotError(404, 'not-found', '来源会话不存在或已归档')
    const task = input.taskId ? state.tasks[input.taskId] : undefined
    if (
      input.taskId &&
      (!task ||
        task.conversationId !== conversation.id ||
        task.stopRequested ||
        !['running', 'waiting'].includes(task.status))
    )
      throw new BotError(403, 'forbidden', '任务已停止或不属于来源会话')
    const botId = task?.botId ?? conversation.coordinatorId
    const bot = state.bots[botId]
    if (!bot?.enabled || !bot.capabilities.includes('images'))
      throw new BotError(403, 'forbidden', '该 Bot 未获图片生成授权')
    const model = input.modelId
      ? state.models[input.modelId]
      : Object.values(state.models).find((entry) => entry.kind === 'image')
    if (!model || model.kind !== 'image' || !['openai', 'openai-compatible'].includes(model.provider))
      throw new BotError(409, 'capability-unavailable', '请配置 OpenAI 或兼容 API 的独立图片模型')
    const checkAuthorization = (latest: AppState) => {
      const currentBot = latest.bots[botId]
      const currentConversation = latest.conversations[conversation.id]
      const currentTask = input.taskId ? latest.tasks[input.taskId] : undefined
      const currentModel = latest.models[model.id]
      if (
        !currentBot?.enabled ||
        !currentBot.capabilities.includes('images') ||
        !currentConversation ||
        currentConversation.archived
      )
        throw new BotError(403, 'forbidden', '图片生成授权已撤销')
      if (
        input.taskId &&
        (!currentTask ||
          currentTask.conversationId !== conversation.id ||
          currentTask.stopRequested ||
          !['running', 'waiting'].includes(currentTask.status))
      )
        throw new BotError(403, 'forbidden', '任务已停止或不属于来源会话')
      if ((!currentTask || currentTask.publicReply) && !currentConversation.memberIds.includes(botId))
        throw new BotError(403, 'forbidden', 'Bot 已不在来源会话中')
      if (currentTask?.parentTaskId) {
        const parent = latest.tasks[currentTask.parentTaskId]
        if (!parent || !latest.bots[parent.botId]?.collaboratorIds.includes(botId))
          throw new BotError(403, 'forbidden', '协作授权已撤销')
      }
      if (
        !currentModel ||
        currentModel.credentialRef !== model.credentialRef ||
        currentModel.kind !== 'image' ||
        currentModel.provider !== model.provider ||
        currentModel.model !== model.model ||
        currentModel.baseUrl !== model.baseUrl
      )
        throw new BotError(409, 'revision-conflict', '图片模型配置已变化，请重新发起')
    }
    const checkAttempts = (latest: AppState) => {
      const generations = Object.values(latest.generations)
      if (
        input.taskId &&
        generations.some(
          (entry) => entry.taskId === input.taskId && ['pending', 'running', 'unknown'].includes(entry.status),
        )
      )
        throw new BotError(
          409,
          'outcome-unknown',
          '该任务已有进行中或结果待核对的生图调用，禁止自动再次生图；请由用户核对后显式创建新尝试',
        )
      if (
        !input.taskId &&
        generations.some(
          (entry) => entry.conversationId === conversation.id && ['pending', 'running'].includes(entry.status),
        )
      )
        throw new BotError(409, 'conflict', '该会话已有进行中的生图调用，请等待原结果')
      const unresolved = generations.filter(
        (entry) =>
          entry.conversationId === conversation.id &&
          entry.status === 'unknown' &&
          !generations.some((attempt) => attempt.previousGenerationId === entry.id),
      )
      if (
        unresolved.length &&
        !(
          unresolved.length === 1 &&
          input.confirmUnknown === true &&
          input.previousGenerationId === unresolved[0].id &&
          !input.taskId
        )
      )
        throw new BotError(
          409,
          'outcome-unknown',
          '该会话有结果与费用待核对的图片；核对后明确确认潜在重复费用，才能创建新尝试',
          { generationIds: unresolved.map((entry) => entry.id), confirmationRequired: true },
        )
      if (
        input.previousGenerationId &&
        (!input.confirmUnknown || !unresolved.some((entry) => entry.id === input.previousGenerationId))
      )
        throw new BotError(409, 'invalid-input', '请确认当前待核对的原生图记录')
    }
    const apiUrl = endpoint(model.baseUrl)
    const credential = await services.store.secret(model.credentialRef)
    if (!credential) throw new BotError(409, 'capability-unavailable', '图片模型尚未配置凭据')
    const signal = AbortSignal.any([shutdown, AbortSignal.timeout(180_000), ...(callerSignal ? [callerSignal] : [])])
    signal.throwIfAborted()
    const now = new Date().toISOString()
    const generation: Generation = {
      id: randomUUID(),
      revision: 1,
      createdAt: now,
      updatedAt: now,
      taskId: input.taskId,
      conversationId: input.conversationId,
      modelId: model.id,
      prompt: input.prompt.trim(),
      status: 'running',
      attachmentIds: [],
      cost: null,
      modelSnapshot: { provider: model.provider, model: model.model, baseUrl: model.baseUrl },
      previousGenerationId: input.previousGenerationId,
    }
    await services.store.update((draft) => {
      checkAuthorization(draft)
      checkAttempts(draft)
      draft.generations[generation.id] = generation
    })
    let sent = false
    let rejected = false
    try {
      signal.throwIfAborted()
      checkAuthorization(services.store.read())
      // No retries or provider fallback: once issued, an interrupted billing result is unknown.
      sent = true
      const response = await fetch(apiUrl, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          Authorization: `Bearer ${credential}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          model: model.model,
          prompt: generation.prompt,
          n: 1,
          size: '1024x1024',
          ...(model.model.startsWith('dall-e') ? { response_format: 'b64_json' } : {}),
        }),
      })
      rejected = [400, 401, 403, 404, 422].includes(response.status)
      if (!response.ok) {
        await response.body?.cancel()
        throw new BotError(502, 'upstream-unavailable', `图片供应商返回 HTTP ${response.status}；请检查模型配置和用量`)
      }
      const payload: unknown = JSON.parse(await readBounded(response))
      const data = (payload as { data?: { b64_json?: unknown; url?: unknown }[] }).data
      if (!Array.isArray(data) || data.length !== 1 || !data[0])
        throw new BotError(502, 'upstream-unavailable', '供应商未返回预期的单张图片')
      let bytes: Uint8Array
      if (typeof data[0].b64_json === 'string') {
        const encoded = data[0].b64_json
        if (
          encoded.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) ||
          encoded.length % 4 !== 0
        )
          throw new BotError(502, 'upstream-unavailable', '图片编码无效或超过大小限制')
        bytes = Buffer.from(encoded, 'base64')
      } else if (typeof data[0].url === 'string') {
        const image = await getPublicResource(data[0].url, { signal, maxBytes: MAX_IMAGE_BYTES, timeoutMs: 30_000 })
        if (image.status !== 200) throw new BotError(502, 'upstream-unavailable', '供应商图片地址下载失败')
        bytes = image.bytes
      } else throw new BotError(502, 'upstream-unavailable', '供应商未返回可下载的图片内容')
      if (!bytes.length || bytes.length > MAX_IMAGE_BYTES)
        throw new BotError(502, 'upstream-unavailable', '图片为空或超过 20 MiB')
      const mime = imageMime(bytes)
      const extension = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1]
      const attachment = await services.saveAttachment({
        name: `image-${generation.id}.${extension}`,
        mime,
        bytes,
        conversationId: conversation.id,
        taskId: input.taskId,
        generationId: generation.id,
        source: 'image',
      })
      await services.store.update((draft) => {
        const current = draft.generations[generation.id]
        current.status = 'completed'
        current.attachmentIds = [attachment.id]
        current.revision++
        current.updatedAt = new Date().toISOString()
        // Charges are unknown unless an authoritative supplier billing receipt exists.
        current.cost = null
        if (
          input.taskId &&
          draft.tasks[input.taskId] &&
          !draft.tasks[input.taskId].stopRequested &&
          ['running', 'waiting'].includes(draft.tasks[input.taskId].status)
        ) {
          const owner = draft.tasks[input.taskId]
          owner.attachmentIds = [...new Set([...owner.attachmentIds, attachment.id])]
          owner.revision++
          owner.updatedAt = current.updatedAt
        }
      })
      return { generationId: generation.id, attachmentIds: [attachment.id] }
    } catch (cause) {
      const uncertain = sent && !rejected
      const message =
        cause instanceof BotError
          ? cause.message
          : signal.aborted
            ? '生图请求中断；请先核对供应商结果与账单'
            : '生图结果未能确认；请先核对供应商结果与账单'
      await services.store.update((draft) => {
        const current = draft.generations[generation.id]
        current.status = uncertain ? 'unknown' : 'failed'
        current.error = message
        current.cost = null
        current.revision++
        current.updatedAt = new Date().toISOString()
      })
      if (!sent && cause instanceof BotError) throw cause
      throw new BotError(uncertain ? 409 : 502, uncertain ? 'outcome-unknown' : 'upstream-unavailable', message, {
        generationId: generation.id,
      })
    }
  }
}
