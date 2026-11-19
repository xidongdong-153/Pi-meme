import { debuglog } from 'node:util'
import { messageAttachmentParts } from '@pi-meme/contracts/chat-attachments'
import { sessionPreviewText, sessionTitleLimit } from '@pi-meme/contracts/sessions'
import type { PiMessage, PiModel } from '@pi-meme/contracts/pi'
import type { SecureCredentialStorage } from '@pi-meme/contracts/secure-storage'
import { loadPiSdk } from './sdk/load'
import { createDesktopModelRuntime } from './sdk/model-runtime'

const promptBytes = 960
const debug = debuglog('pi-meme-session-title')
const instructions = [
  `Generate a concise, single-line task title of at most ${sessionTitleLimit} characters and under five words where possible.`,
  "Start with an imperative verb. Capitalize only the first word unless the user's language, proper nouns, acronyms, or code terms require otherwise.",
  "Preserve ticket references exactly. Write in the user's language.",
  'Do not use quotes, markdown, or trailing punctuation. Do not answer the request.',
  'Return {"title":"…"} or call the supplied title output tool.',
].join(' ')
const titleSchema = {
  type: 'object',
  properties: { title: { type: 'string', minLength: 1, maxLength: sessionTitleLimit } },
  required: ['title'],
  additionalProperties: false,
}

export function titleUserText(message: Extract<PiMessage, { role: 'user' }>) {
  const raw =
    typeof message.content === 'string'
      ? message.content
      : message.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('\n')
  return sessionPreviewText(messageAttachmentParts(raw).text)
}

const xmlEntities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }

// Count each escaped character as one unit so the byte limit also preserves XML entities.
function boundedText(text: string, bytes: number, xml = false) {
  let result = ''
  for (const char of text) {
    const value = xml ? (xmlEntities[char] ?? char) : char
    bytes -= Buffer.byteLength(value)
    if (bytes < 0) break
    result += value
  }
  return result
}

export function sessionTitlePrompt(text: string) {
  const prefix = `${instructions}\n\nUser prompt:\n`
  return prefix + boundedText(text.trim(), promptBytes - Buffer.byteLength(prefix))
}

function isCommentary(signature?: string) {
  if (!signature?.startsWith('{')) return false
  try {
    return JSON.parse(signature)?.phase === 'commentary'
  } catch {
    return false
  }
}

export function suggestedTitlePrompt(messages: readonly PiMessage[]) {
  const recent: Array<{ role: 'user' | 'assistant'; text: string }> = []
  for (let i = messages.length - 1; i >= 0 && recent.length < 8; i--) {
    const message = messages[i]
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const text =
      message.role === 'user'
        ? titleUserText(message)
        : message.content
            .flatMap((part) => (part.type === 'text' && !isCommentary(part.textSignature) ? [part.text] : []))
            .join('\n')
            .trim()
    if (text) recent.push({ role: message.role, text })
  }
  if (!recent.length) return null
  recent.reverse()
  const prefix = `${instructions}\nPrioritize the current task and latest substantive user request.\n\nRecent conversation messages:\n<conversation>\n`
  const suffix = '\n</conversation>'
  const wrap = (role: string, text: string) => `<message role="${role}">${text}</message>`
  const markup = recent.map(({ role }) => wrap(role, '')).join('\n')
  const available = promptBytes - Buffer.byteLength(prefix + markup + suffix)
  const format = (bytes: number) =>
    prefix + recent.map(({ role, text }) => wrap(role, boundedText(text, bytes, true))).join('\n') + suffix
  const full = format(available)
  return Buffer.byteLength(full) <= promptBytes ? full : format(Math.floor(available / recent.length))
}

function parseSessionTitle(response: string) {
  if (!response.trimStart().startsWith('{')) return null
  try {
    const value = JSON.parse(response)
    if (typeof value.title !== 'string' || Object.keys(value).length !== 1) return null
    const normalized = value.title
      .trim()
      .replace(/^["'`“”‘’]+|["'`“”‘’]+$/gu, '')
      .trim()
      .replace(/\s+/gu, ' ')
      .replace(/[.?!]+$/u, '')
      .trimEnd()
    return Array.from(normalized).slice(0, sessionTitleLimit).join('') || null
  } catch {
    return null
  }
}

/** One isolated completion, with no agent tools, session history or provider continuation. */
export async function generateSessionTitle(
  agentDir: string,
  credentials: SecureCredentialStorage,
  selected: PiModel,
  prompt: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted()
  const runtime = await createDesktopModelRuntime(await loadPiSdk(), agentDir, credentials)
  const model = runtime
    .getAvailableSnapshot()
    .find((entry) => entry.provider === selected.provider && entry.id === selected.id)
  if (!model) return null
  signal.throwIfAborted()
  const responses = ['openai-responses', 'openai-codex-responses', 'azure-openai-responses'].includes(model.api)
  const output = {
    name: 'session_title',
    description: 'Return the task title.',
    parameters: titleSchema,
    constrainedSampling: { type: 'json_schema', strict: 'prefer' },
  } as const
  const result = await runtime.completeSimple(
    model,
    {
      messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
      tools: responses ? [] : [output],
    },
    {
      signal,
      disableContinuation: true,
      maxTokens: Math.min(1024, model.maxTokens || 1024),
      maxRetries: 0,
      onPayload: responses
        ? (payload) => {
            const body = payload as { text?: Record<string, unknown> }
            return {
              ...body,
              text: {
                ...body.text,
                format: { type: 'json_schema', name: output.name, schema: titleSchema, strict: true },
              },
            }
          }
        : undefined,
    },
  )
  if (result.stopReason === 'error') throw new Error(result.errorMessage ?? 'Title request failed')
  if (result.stopReason === 'toolUse' && !responses) {
    const calls = result.content.filter((part) => part.type === 'toolCall')
    return calls.length === 1 && calls[0].name === output.name
      ? parseSessionTitle(JSON.stringify(calls[0].arguments))
      : null
  }
  if (result.stopReason !== 'stop') return null
  return parseSessionTitle(
    result.content
      .flatMap((part) => (part.type === 'text' && !isCommentary(part.textSignature) ? [part.text] : []))
      .join(''),
  )
}

type TitleRequest = { controller: AbortController; result: Promise<string | null> }

export class SessionTitleRequests {
  private pending = { automatic: new Map<string, TitleRequest>(), suggestion: new Map<string, TitleRequest>() }
  readonly writes = new Map<string, Promise<void>>()

  run(
    key: string,
    destination: keyof SessionTitleRequests['pending'],
    work: (signal: AbortSignal) => Promise<string | null>,
  ) {
    const pending = this.pending[destination]
    const existing = pending.get(key)
    if (existing) return existing.result
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)])
    const result = Promise.resolve()
      .then(() => {
        signal.throwIfAborted()
        return work(signal)
      })
      .then((title) => (signal.aborted ? null : title))
      .catch((cause) => {
        if (!controller.signal.aborted) debug('%s title generation failed: %s', destination, String(cause))
        return null
      })
      .finally(() => {
        if (pending.get(key)?.controller === controller) pending.delete(key)
      })
    pending.set(key, { controller, result })
    return result
  }

  cancel(key?: string) {
    for (const pending of Object.values(this.pending)) {
      for (const [id, request] of pending) {
        if (key !== undefined && id !== key) continue
        request.controller.abort()
        pending.delete(id)
      }
    }
  }

  async write(key: string, action: () => Promise<void>) {
    const previous = this.writes.get(key)
    const next = (previous ?? Promise.resolve()).catch(() => {}).then(action)
    this.writes.set(key, next)
    try {
      await next
    } finally {
      if (this.writes.get(key) === next) this.writes.delete(key)
    }
  }
}
