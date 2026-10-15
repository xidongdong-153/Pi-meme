// @ts-check
// 本地 OpenAI 兼容端点：让集成测试在不联网的情况下跑通提示词、工具调用与中断流程。
import { createServer } from 'node:http'

/**
 * @typedef {object} FakeReply
 * @property {string} [text] 回复正文
 * @property {string} [thinking] 思考内容，作为 `reasoning_content` 增量发送
 * @property {number} [delayMs] 开始流式输出前等待的毫秒数
 * @property {Promise<void>} [deltaBarrier] 等待测试解除屏障后才发送结束增量
 * @property {Promise<void>} [finishBarrier] 等待测试解除屏障后才结束请求
 * @property {number} [chunkDelayMs] 正文分片间隔毫秒数
 * @property {number} [holdMs] 正文与工具调用发送完之后保持连接不结束的毫秒数
 * @property {{ id?: string; name: string; arguments?: string }} [tool] 正文之后发起的工具调用
 * @property {number} [status] 大于等于 400 时直接返回错误响应
 */

/**
 * @typedef {object} FakeProviderOptions
 * @property {string | FakeReply | ((body: any, index: number) => string | FakeReply | Promise<string | FakeReply>)} [reply]
 * 默认回复，或按请求体生成回复的函数。
 * @property {(body: any, index: number) => void} [onRequest] 收到请求时的断言钩子，抛错则返回 500。
 */

const composerHintPrefix = '你是输入框提示。'

/** @param {import('node:http').ServerResponse} res @param {number} status @param {unknown} body */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

/** @param {unknown} delta @param {string | null} [finish] */
function chunk(delta, finish = null) {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-fake',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fake-model',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`
}

/** @param {any} message */
function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((/** @type {any} */ part) => (typeof part === 'string' ? part : (part?.text ?? ''))).join('')
}

/**
 * 输入框提示是独立完成。推理模型会把系统提示放进 developer 消息，不能据此消耗用户轮次脚本。
 *
 * @param {any} body
 */
function isComposerHint(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  return messages.some((/** @type {any} */ message) => {
    if (message?.role !== 'system' && message?.role !== 'developer') return false
    return messageText(message).startsWith(composerHintPrefix)
  })
}

/**
 * 拼接请求体中所有消息的文本；用户消息的 content 是分片数组，历史消息是纯字符串。
 * 受限模式下 Pi 会在用户消息后追加自定义消息，所以不能只看最后一条。
 *
 * @param {any} body
 * @returns {string} 拼接后的文本
 */
export function requestText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  return messages.map((/** @type {any} */ message) => messageText(message)).join('\n')
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {FakeReply} spec
 */
async function writeCompletion(res, spec) {
  if (spec.status && spec.status >= 400) {
    sendJson(res, spec.status, { error: { message: spec.text ?? '请求失败' } })
    return
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  if (spec.delayMs) await new Promise((resolve) => setTimeout(resolve, spec.delayMs))
  if (res.destroyed) return
  res.write(chunk({ role: 'assistant', content: '' }))
  if (res.destroyed) return
  for (const piece of String(spec.thinking ?? '').match(/[\s\S]{1,24}/g) ?? []) {
    res.write(chunk({ reasoning_content: piece }))
    if (res.destroyed) return
    await new Promise((resolve) => setTimeout(resolve, spec.chunkDelayMs ?? 1))
  }
  for (const piece of String(spec.text ?? '').match(/[\s\S]{1,24}/g) ?? []) {
    res.write(chunk({ content: piece }))
    if (res.destroyed) return
    await new Promise((resolve) => setTimeout(resolve, spec.chunkDelayMs ?? 1))
  }
  if (spec.deltaBarrier) await spec.deltaBarrier
  if (res.destroyed) return
  if (spec.tool) {
    res.write(
      chunk({
        tool_calls: [
          {
            index: 0,
            id: spec.tool.id ?? 'call_fake_1',
            type: 'function',
            function: { name: spec.tool.name, arguments: spec.tool.arguments ?? '{}' },
          },
        ],
      }),
    )
    if (res.destroyed) return
    res.write(chunk({}, 'tool_calls'))
  } else {
    res.write(chunk({}, 'stop'))
  }
  if (spec.finishBarrier) await spec.finishBarrier
  if (spec.holdMs) await new Promise((resolve) => setTimeout(resolve, spec.holdMs))
  if (res.destroyed) return
  res.write(
    `data: ${JSON.stringify({
      id: 'chatcmpl-fake',
      object: 'chat.completion.chunk',
      model: 'fake-model',
      choices: [],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    })}\n\n`,
  )
  res.write('data: [DONE]\n\n')
  res.end()
}

/**
 * 启动假模型服务。
 *
 * @param {FakeProviderOptions} [options]
 * @returns {Promise<{ baseUrl: string; requests: any[]; sideRequests: any[]; close: () => Promise<void> }>} 服务句柄，baseUrl 用于写入 models.json。
 */
export async function startFakeProvider(options = {}) {
  /** @type {any[]} */
  const requests = []
  /** @type {any[]} */
  const sideRequests = []
  const server = createServer((req, res) => {
    const url = req.url ?? ''
    let raw = ''
    req.on('data', (/** @type {Buffer} */ part) => {
      raw += part
    })
    req.on('end', async () => {
      if (req.method === 'GET' && url.startsWith('/v1/models')) {
        sendJson(res, 200, { object: 'list', data: [{ id: 'fake-model', object: 'model' }] })
        return
      }
      if (req.method !== 'POST' || !url.startsWith('/v1/chat/completions')) {
        sendJson(res, 404, { error: { message: `未知路径：${url}` } })
        return
      }
      let body
      try {
        body = JSON.parse(raw)
      } catch {
        sendJson(res, 400, { error: { message: '请求体不是 JSON' } })
        return
      }
      if (isComposerHint(body)) {
        sideRequests.push(body)
        await writeCompletion(res, { text: '{"show":false}' })
        return
      }
      requests.push(body)
      try {
        options.onRequest?.(body, requests.length)
      } catch (error) {
        sendJson(res, 500, { error: { message: String(error) } })
        return
      }
      const result =
        typeof options.reply === 'function' ? await options.reply(body, requests.length) : (options.reply ?? '测试回复')
      const spec = typeof result === 'string' ? { text: result } : result
      await writeCompletion(res, spec)
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(undefined))
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    /** models.json 里使用的 baseUrl。 */
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    sideRequests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}
