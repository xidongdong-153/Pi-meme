// @ts-check
/** @returns {import('@earendil-works/pi-ai').Usage} 返回符合 Pi 类型的测试数据。 */
export function zeroUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

/**
 * @param {string | import('@earendil-works/pi-ai').AssistantMessage['content']} content
 * @param {number} timestamp
 * @param {Partial<import('@earendil-works/pi-ai').AssistantMessage>} overrides
 * @returns {import('@earendil-works/pi-ai').AssistantMessage} 返回符合 Pi 类型的测试数据。
 */
export function assistantMessage(content = '', timestamp = Date.now(), overrides = {}) {
  return {
    role: 'assistant',
    content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
    api: 'openai-completions',
    provider: 'fake',
    model: 'first',
    usage: zeroUsage(),
    stopReason: 'stop',
    timestamp,
    ...overrides,
  }
}

/**
 * @param {import('@earendil-works/pi-ai').UserMessage['content']} content
 * @param {number} timestamp
 * @returns {import('@earendil-works/pi-ai').UserMessage} 返回符合 Pi 类型的测试数据。
 */
export function userMessage(content = '', timestamp = Date.now()) {
  return { role: 'user', content, timestamp }
}

/**
 * @param {string} id
 * @param {string} content
 * @param {number} timestamp
 * @param {boolean} isError
 * @returns {import('@earendil-works/pi-ai').ToolResultMessage} 返回符合 Pi 类型的测试数据。
 */
export function toolResult(id, content = '', timestamp = Date.now(), isError = false) {
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName: 'custom',
    content: [{ type: 'text', text: content }],
    timestamp,
    isError,
  }
}

/**
 * @param {string} command
 * @param {string} output
 * @param {number} timestamp
 * @returns {Extract<import('../../packages/contracts/src/pi').PiMessage, { role: 'bashExecution' }>} 返回符合 Pi 类型的测试数据。
 */
export function bashMessage(command, output, timestamp = Date.now()) {
  return { role: 'bashExecution', command, output, timestamp, exitCode: 0, cancelled: false, truncated: false }
}

/**
 * @param {string} id
 * @param {string} provider
 * @returns {import('@earendil-works/pi-ai').Model<'openai-completions'>} 返回符合 Pi 类型的测试数据。
 */
export function fakeModel(id = 'first', provider = 'fake') {
  return {
    id,
    name: id,
    provider,
    api: 'openai-completions',
    baseUrl: 'http://localhost.invalid',
    reasoning: false,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  }
}

/**
 * @param {Partial<import('@earendil-works/pi-coding-agent').RpcSessionState>} overrides
 * @returns {import('@earendil-works/pi-coding-agent').RpcSessionState} 返回符合 Pi 类型的测试数据。
 */
export function sessionState(overrides = {}) {
  return {
    model: fakeModel(),
    thinkingLevel: 'off',
    isStreaming: false,
    isCompacting: false,
    steeringMode: 'one-at-a-time',
    followUpMode: 'one-at-a-time',
    sessionId: 'test-session',
    autoCompactionEnabled: true,
    messageCount: 0,
    pendingMessageCount: 0,
    ...overrides,
  }
}

/**
 * @param {Extract<import('@earendil-works/pi-coding-agent').JsonAgentSessionEvent, { type: 'message_update' }>['assistantMessageEvent']} update
 * @returns {Extract<import('@earendil-works/pi-coding-agent').JsonAgentSessionEvent, { type: 'message_update' }>} 返回符合 Pi 类型的测试数据。
 */
export function streamUpdate(update) {
  return { type: 'message_update', usage: zeroUsage(), assistantMessageEvent: update }
}
