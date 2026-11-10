import { randomBytes, randomUUID } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import type { AssistantMessage, Context as ModelContext } from '@earendil-works/pi-ai'
import type { ModelVerification } from '../shared/types.js'
import type { BotStore } from './contracts.js'
import { BotError, requireItem, revision, text, touch } from './errors.js'
import { catalogModel, localAnonymousModel } from './model-metadata.js'
import { effectiveModel, modelFingerprint, modelSettingsView } from './model-settings.js'
import { createBotModels, installModel, modelProviderId } from './models.js'

const checks = new WeakMap<BotStore, Set<string>>()
const colors = ['red', 'green', 'blue', 'yellow'] as const
const palette = [
  [230, 30, 30],
  [20, 180, 40],
  [30, 70, 230],
  [245, 220, 20],
]
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
function pngChunk(type: string, data: Uint8Array) {
  const name = Buffer.from(type)
  const size = Buffer.alloc(4)
  size.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([size, name, data, crc])
}
/** Random image ground truth stays server-side; the prompt only contains a nonce and color vocabulary. */
function imageChallenge() {
  const picks = [...randomBytes(8)].map((byte) => byte % palette.length)
  const width = picks.length * 32
  const height = 40
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const boundary = y === 0 || y === height - 1 || x % 32 === 0 || x % 32 === 31
      const rgb = boundary ? [0, 0, 0] : palette[picks[Math.floor(x / 32)]]!
      const offset = y * (width * 3 + 1) + 1 + x * 3
      for (let channel = 0; channel < 3; channel++) raw[offset + channel] = rgb[channel]!
    }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const bytes = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
  return { data: bytes.toString('base64'), expected: picks.map((pick) => colors[pick]) }
}
function checkError(message: AssistantMessage) {
  if (message.stopReason !== 'error' && message.stopReason !== 'aborted') return
  const status = message.errorMessage?.match(/\b(400|401|403|404|408|413|415|422|429|500|502|503|504)\b/)?.[1]
  throw new BotError(
    502,
    'model-check-failed',
    status ? `模型服务拒绝了验证请求（HTTP ${status}）` : '模型验证请求失败或超时，请检查连接与凭据后手动重试',
  )
}

export async function checkModelSettings(store: BotStore, input: Record<string, unknown>) {
  const modelId = text(input.modelId, '模型ID', 128)
  const initial = store.read()
  if (input.revision !== undefined) revision(initial.modelSettings, input.revision)
  const raw = requireItem(initial.models[modelId], '模型')
  if (raw.kind !== 'text') throw new BotError(400, 'invalid-input', '请选择对话模型进行图片输入与工具调用验证')
  const running = checks.get(store) ?? new Set<string>()
  checks.set(store, running)
  if (running.has(modelId)) throw new BotError(409, 'model-check-running', '该模型正在验证，请等待当前请求结束')
  running.add(modelId)
  const fingerprint = modelFingerprint(initial, raw)
  const config = effectiveModel(initial, raw)
  const verification: ModelVerification = { status: 'unknown', fingerprint, checkedAt: new Date().toISOString() }
  try {
    try {
      if (!config.credentialRef && !localAnonymousModel(config))
        throw new BotError(400, 'model-check-failed', '请先配置模型服务凭据')
      const known = catalogModel(config)
      if (known && !known.input.includes('image')) {
        verification.status = 'unsupported'
        verification.imageInput = false
        verification.error = 'Pi 模型目录声明此模型不支持图片输入，请选择多模态对话模型'
      } else {
        const models = createBotModels()
        installModel(models, config, store)
        const model = models.getModel(modelProviderId(config), config.model)
        if (!model) throw new BotError(409, 'model-check-failed', '模型连接尚未就绪')
        const challenge = imageChallenge()
        const nonce = randomUUID()
        const toolName = 'verify_image_colors'
        const tools = [
          {
            name: toolName,
            description:
              'A harmless local verification tool. Report the eight panel colors left to right, plus the supplied nonce. It has no external effects.',
            parameters: {
              type: 'object',
              properties: {
                colors: { type: 'array', items: { type: 'string', enum: [...colors] }, minItems: 8, maxItems: 8 },
                nonce: { type: 'string', const: nonce },
              },
              required: ['colors', 'nonce'],
              additionalProperties: false,
            },
          },
        ]
        const request: ModelContext = {
          systemPrompt:
            'This is a capability check. Read the attached image and call the verification tool exactly once. After the tool returns, reply with only its receipt.',
          messages: [
            {
              role: 'user',
              timestamp: Date.now(),
              content: [
                {
                  type: 'text',
                  text: `Read the eight framed colored panels from left to right. Use only red, green, blue, yellow for their interior colors. Call ${toolName} with those eight colors and nonce ${nonce}.`,
                },
                { type: 'image', mimeType: 'image/png', data: challenge.data },
              ],
            },
          ],
          tools,
        }
        // One explicit check has at most two model turns. SDK and logical retries are disabled.
        const options = {
          maxRetries: 0,
          timeoutMs: 45_000,
          signal: AbortSignal.timeout(60_000),
          maxTokens: Math.min(config.maxTokens ?? 2048, 1024),
        }
        const first = await models.completeSimple(model, request, options)
        checkError(first)
        const calls = first.content.filter((block) => block.type === 'toolCall')
        const call = calls[0]
        if (
          calls.length !== 1 ||
          !call ||
          call.name !== toolName ||
          call.argumentsError ||
          call.arguments.nonce !== nonce ||
          !Array.isArray(call.arguments.colors) ||
          call.arguments.colors.length !== challenge.expected.length ||
          call.arguments.colors.some((color, index) => color !== challenge.expected[index])
        ) {
          verification.status = first.stopReason === 'length' ? 'unknown' : 'unsupported'
          verification.error = '未通过实际图片识别与安全工具调用检查，请确认模型同时支持图片输入和工具调用'
        } else {
          verification.imageInput = true
          const receipt = randomUUID()
          const second = await models.completeSimple(
            model,
            {
              ...request,
              messages: [
                ...request.messages,
                first,
                {
                  role: 'toolResult',
                  toolCallId: call.id,
                  toolName,
                  timestamp: Date.now(),
                  isError: false,
                  content: [{ type: 'text', text: JSON.stringify({ receipt }) }],
                },
              ],
            },
            options,
          )
          checkError(second)
          const received = second.content
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('')
            .trim()
          if (received === receipt && second.stopReason === 'stop') {
            verification.status = 'verified'
            verification.toolCalls = true
          } else {
            verification.status = 'unsupported'
            verification.error = '模型没有完成安全工具结果往返，请选择同时支持图片与工具调用的模型'
          }
        }
      }
    } catch (cause) {
      verification.status = 'failed'
      verification.error =
        cause instanceof BotError ? cause.message : '模型验证请求失败或超时，请检查连接与凭据后手动重试'
    }
    await store.update((state) => {
      if (state.modelSettings.revision !== initial.modelSettings.revision)
        throw new BotError(409, 'revision-conflict', '验证期间模型配置已改变，请读取当前配置后重新验证', {
          revision: state.modelSettings.revision,
        })
      const current = requireItem(state.models[modelId], '模型')
      if (modelFingerprint(state, current) !== fingerprint)
        throw new BotError(409, 'stale-model-check', '模型连接已改变，本次验证结果已丢弃')
      current.verification = verification
      touch(current)
      state.modelSettings.revision++
    })
    return modelSettingsView(store.read())
  } finally {
    running.delete(modelId)
  }
}
