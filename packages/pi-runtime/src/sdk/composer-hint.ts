/** 一轮结束后，让模型决定要不要在输入框放一句下一步。默认不显示。 */
export const composerHintSystemPrompt = [
  '你是输入框提示。根据刚结束的一轮对话，决定要不要给用户一句下一步。',
  '只输出 JSON：{"show":false} 或 {"show":true,"text":"..."}。',
  '默认 show 为 false。只有一件明确、用户很可能接着做的事才显示，例如提交、推送、跑测试、按刚才的结论再改一处。',
  '这些情况必须 show 为 false：要求已经做完且没有残留动作；还在等用户补充；下一步有好几件，分不出主次；只能写出空话。',
  'text 不超过 20 个字，是用户会直接发送给助手的一句话，不要解释，不要加引号。',
].join('\n')

const maxHintLength = 24

export type HintSourceMessage = {
  role: string
  content?: string | ReadonlyArray<{ type?: string; text?: string; name?: string; arguments?: unknown }>
  toolName?: string
  isError?: boolean
  stopReason?: string
  errorMessage?: string
  command?: string
}

function clip(value: string, max: number) {
  const flat = value.replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function textOf(message: HintSourceMessage) {
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content)) return ''
  return message.content
    .filter((part) => part.type === 'text' && part.text)
    .map((part) => part.text)
    .join('')
}

function describeTool(name: string, args: unknown) {
  const record = args && typeof args === 'object' ? (args as Record<string, unknown>) : {}
  const command = typeof record.command === 'string' ? clip(record.command, 80) : ''
  if (command) return `${name} ${command}`
  const path =
    typeof record.path === 'string'
      ? record.path
      : typeof record.file === 'string'
        ? record.file
        : typeof record.filePath === 'string'
          ? record.filePath
          : ''
  if (path) return `${name} ${path.split(/[/\\]/u).pop()}`
  return name
}

/** 压成本轮摘要。没有成对的用户消息和助手回复时返回 null，调用方不要再问模型。 */
export function summarizeTurn(messages: readonly HintSourceMessage[]): string | null {
  let assistant = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'assistant') {
      assistant = index
      break
    }
  }
  if (assistant < 0) return null
  let user = -1
  for (let index = assistant - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      user = index
      break
    }
  }
  if (user < 0) return null
  const lines: string[] = []
  const userText = clip(textOf(messages[user]!), 200)
  if (userText) lines.push(`用户：${userText}`)
  const reply = messages[assistant]!
  const assistantText = clip(textOf(reply), 400)
  if (assistantText) lines.push(`助手：${assistantText}`)
  if (reply.stopReason === 'error' || reply.errorMessage)
    lines.push(`错误：${clip(reply.errorMessage || '模型执行失败', 200)}`)
  const tools: string[] = []
  for (const message of messages.slice(user + 1, assistant + 1)) {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === 'toolCall' && part.name) tools.push(describeTool(part.name, part.arguments))
      }
    }
    if (message.role === 'toolResult' && message.isError) tools.push(`${message.toolName || '工具'} 失败`)
    if (message.role === 'bashExecution' && message.command) tools.push(`bash ${clip(message.command, 80)}`)
  }
  if (tools.length) lines.push(`工具：${tools.slice(0, 8).join('；')}`)
  return lines.length ? lines.join('\n') : null
}

/** 模型输出不是一句可用提示时返回 null，界面保持原来的占位。 */
export function parseComposerHint(raw: string): string | null {
  const trimmed = raw.trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const value = parsed as { show?: unknown; text?: unknown }
  if (value.show !== true || typeof value.text !== 'string') return null
  const text = value.text.replace(/\s+/g, ' ').trim()
  if (!text || text.length > maxHintLength) return null
  return text
}

export function composerHintFromAssistant(message: {
  stopReason?: string
  content?: ReadonlyArray<{ type?: string; text?: string }>
}): string | null {
  if (message.stopReason && message.stopReason !== 'stop') return null
  const text = (message.content ?? [])
    .filter((part) => part.type === 'text' && part.text)
    .map((part) => part.text)
    .join('')
  return parseComposerHint(text)
}
