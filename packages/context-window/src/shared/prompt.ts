/*
 * Adapted from https://github.com/yetone/magpie
 * internal/gateway/prompt.go and internal/gateway/prompt_text.go.
 * MIT License — Copyright (c) 2026 yetone
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { contextPartKinds } from '@pi-meme/contracts/context-window'
import type {
  ContextPartKind,
  ContextPiece,
  ContextPrompt,
  ContextPromptItem,
  ContextTextItem,
} from '@pi-meme/contracts/context-window'

type ObjectValue = Record<string, unknown>
type ToolCall = { name: string; files: string[] }
type Entry = ContextTextItem & { n: number }
const encoder = new TextEncoder()
const imageTokens = 1600
const summaryItems = 24
function object(value: unknown): ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as ObjectValue) : {}
}
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const string = (value: unknown): string => (typeof value === 'string' ? value : '')
const bytes = (value: string): number => encoder.encode(value).length
const itemId = (kind: ContextPartKind, tag: string, name: string): string => JSON.stringify([kind, tag, name])
const textPiece = (role: ContextPiece['role'], text: string): ContextPiece => ({ role, text })
const sealedPiece = (size: number): ContextPiece => ({ role: 'sealed', size })
function compareNames(a: ContextPromptItem, b: ContextPromptItem): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : (a.tag || '').localeCompare(b.tag || '')
}
const bySize = (a: ContextPromptItem, b: ContextPromptItem): number => b.tokens - a.tokens || compareNames(a, b)

function tokensOf(text: string): number {
  let ascii = 0
  let other = 0
  for (const rune of text) {
    if (rune.codePointAt(0)! < 128) ascii++
    else other++
  }
  return Math.ceil(ascii / 4) + other
}

// Preserve raw object/array spans: schema whitespace and non-ASCII bytes count
// as they did in Magpie, rather than measuring a reserialized JSON object.
function decode(body: string): { value: ObjectValue; raw: (value: unknown) => string } {
  const value: unknown = JSON.parse(body)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a request object')
  const spans = new WeakMap<object, [number, number]>()
  let at = 0
  const space = () => {
    while (/\s/.test(body[at] || '') && at < body.length) at++
  }
  const quoted = () => {
    const start = at++
    while (at < body.length) {
      const c = body[at++]
      if (c === '\\') at++
      else if (c === '"') break
    }
    return body.slice(start, at)
  }
  const visit = (current: unknown): void => {
    space()
    const start = at
    if (body[at] === '{') {
      at++
      space()
      while (body[at] !== '}') {
        const key: string = JSON.parse(quoted())
        space()
        at++ // colon; the whole body was already validated by JSON.parse
        visit(object(current)[key])
        space()
        if (body[at] !== ',') break
        at++
        space()
      }
      at++
    } else if (body[at] === '[') {
      at++
      space()
      let index = 0
      while (body[at] !== ']') {
        visit(array(current)[index++])
        space()
        if (body[at] !== ',') break
        at++
      }
      at++
    } else if (body[at] === '"') quoted()
    else while (at < body.length && !/[\s,\]}]/.test(body[at])) at++
    if (current && typeof current === 'object') spans.set(current, [start, at])
  }
  visit(value)
  return {
    value: object(value),
    raw: (current) => {
      const span = current && typeof current === 'object' ? spans.get(current) : undefined
      return span ? body.slice(...span) : current === undefined ? '' : JSON.stringify(current)
    },
  }
}

const contentsOf = /^Contents of (\S.*?) \(([^()\n]*(?:\([^()\n]*\)[^()\n]*)*)\):[ \t]*$/gm
const instructionsFrom = /^Instructions from: (\S.*)$/gm
const agentsFor = /^# (\S+\.md) instructions for (\S.*)\n/
const skillsList = 'The following skills are available for use with the Skill tool:'
const injected = [
  '<system-reminder',
  '<environment_context>',
  '<user_instructions>',
  '<turn_aborted>',
  '<user_shell_command>',
  '<subagent_notification>',
  '<in-app-browser-context',
  '<external_codex_apps_open_page>',
  '<session-context',
  '<task-notification>',
  '<subagent-notification>',
  '<plugin_reference>',
  'Available agent types for the Agent tool:',
  'Available agent types and the tools they have access to:',
  'New agent types are now available for the Agent tool:',
  "The TodoWrite tool hasn't been used recently.",
  "The task tools haven't been used recently.",
  'Conversation rewind applied.',
  'Workspace rewind applied.',
]
function userSays(text: string): boolean {
  let rest = text.replace(/<system-reminder(?:\s[^>]*)?>[\s\S]*?<\/system-reminder>/g, '').trim()
  const requests = [...rest.matchAll(/^## My request(?: for Codex)?:[ \t]*\n?/gm)]
  const last = requests.at(-1)
  if (last) rest = rest.slice(last.index! + last[0].length).trim()
  return !!rest && !agentsFor.test(rest) && !injected.some((lead) => rest.startsWith(lead))
}
function memoryTag(path: string, description: string): string {
  const desc = description.toLowerCase()
  if (desc.includes("user's") || desc.includes('global')) return 'user'
  if (desc.includes('local')) return 'local'
  if (desc.includes('auto-memory') || desc.includes('memory')) return 'memory'
  if (desc) return 'project'
  return ['/.claude/', '/.codex/', '/.config/'].some((part) => path.includes(part)) ? 'user' : 'project'
}
function harnessName(text: string, fallback: string): string {
  const tag = /^\s*<([a-zA-Z_][\w -]{0,40})>/.exec(text)
  return tag ? tag[1].trim() : text.startsWith('# Environment') ? 'environment' : fallback
}
const readTools = new Set([
  'Read',
  'read',
  'read_file',
  'ReadFile',
  'view',
  'View',
  'NotebookRead',
  'readFile',
  'open_file',
  'cat',
])
const pathKeys = ['file_path', 'path', 'filePath', 'target_file', 'notebook_path', 'file', 'filename', 'uri']
function filesOfCommand(command: string): string[] {
  let cmd = command.trim()
  for (const prefix of ['bash -lc ', 'bash -c ', 'sh -c ', 'zsh -lc ']) {
    if (cmd.startsWith(prefix))
      cmd = cmd
        .slice(prefix.length)
        .trim()
        .replace(/^["']+|["']+$/g, '')
  }
  if (/[|;&><`$]/.test(cmd)) {
    const at = cmd.indexOf('&&')
    if (at >= 0 && cmd.startsWith('cd ') && !/[|;&><`$]/.test(cmd.slice(at + 2))) cmd = cmd.slice(at + 2).trim()
    else return []
  }
  const fields = cmd.split(/\s+/)
  if (fields.length < 2) return []
  const sed = fields[0] === 'sed' && fields.includes('-n')
  if (!new Set(['cat', 'head', 'tail', 'nl', 'bat', 'less', 'more']).has(fields[0]) && !sed) return []
  const files: string[] = []
  for (let i = 1; i < fields.length; i++) {
    const arg = fields[i].replace(/^["']+|["']+$/g, '')
    if (arg.startsWith('-')) {
      if ((arg === '-n' || arg === '-c') && !sed && i + 1 < fields.length) i++
      continue
    }
    if (sed && arg.endsWith('p') && /[\d,]/.test(arg) && !/[/.]/.test(arg)) continue
    if (/^[+-]?\d+$/.test(arg)) continue
    files.push(arg)
  }
  return files
}
function callOf(name: string, input: unknown): ToolCall {
  let parsed = input
  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input)
    } catch {
      parsed = undefined
    }
  }
  const args = object(parsed)
  if (readTools.has(name)) {
    for (const key of pathKeys) if (string(args[key])) return { name, files: [string(args[key])] }
  }
  let command = string(args.command) || string(args.cmd)
  if (!command && Array.isArray(args.command)) command = args.command.map(string).join(' ')
  if (!command && parsed === undefined && typeof input === 'string') {
    name = /\btools\.(\w+)\s*\(/.exec(input)?.[1] || name
    const cmd = /\bcmd\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(input)
    if (cmd) {
      try {
        command = JSON.parse(`"${cmd[1]}"`)
      } catch {
        /* leave unread */
      }
    }
  }
  return { name, files: command ? filesOfCommand(command) : [] }
}
function imageSource(source: unknown): string | undefined {
  const src = object(source)
  const value =
    typeof source === 'string'
      ? source
      : string(src.url) || `data:${string(src.media_type) || string(src.mimeType)};base64,${string(src.data)}`
  return /^data:image\/(?:png|jpeg|jpg|gif|webp);base64,[A-Z0-9+/=]+$/i.test(value) ? value : undefined
}
function blocks(content: unknown): ObjectValue[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : array(content).map(object)
}
function responseContent(content: unknown): { text: string; image: boolean; source?: unknown }[] {
  if (typeof content === 'string') return [{ text: content, image: false }]
  return array(content).map((entry) => {
    const part = object(entry)
    return {
      text: string(part.text),
      image: ['input_image', 'input_file', 'image_url'].includes(string(part.type)),
      source: part.image_url,
    }
  })
}

class PromptBuilder {
  readonly parts = new Map<ContextPartKind, Map<string, Entry>>()
  readonly calls = new Map<string, ToolCall>()
  turn = 0
  held = false
  constructor(
    private readonly raw: (value: unknown) => string,
    private readonly keep: boolean,
  ) {}
  rawTokens(value: unknown): number {
    return Math.ceil(bytes(this.raw(value)) / 4)
  }
  rawPiece(role: ContextPiece['role'], name: string, value: unknown, literal = false): ContextPiece {
    if (!this.keep) return { role }
    let text = literal ? string(value).trim() : this.raw(value).trim()
    try {
      let parsed: unknown = JSON.parse(text)
      if (typeof parsed === 'string') {
        text = parsed
        try {
          parsed = JSON.parse(text)
        } catch {
          return { role, name, text }
        }
      }
      text = JSON.stringify(parsed, null, 2)
    } catch {
      /* custom tools may carry plain text */
    }
    return { role, name, text }
  }
  image(source: unknown): ContextPiece {
    return { role: 'image', ...(this.keep ? { src: imageSource(source) } : {}) }
  }
  add(kind: ContextPartKind, name: string, tag: string, tokens: number, piece: ContextPiece): void {
    if (tokens <= 0) return
    let part = this.parts.get(kind)
    if (!part) {
      part = new Map()
      this.parts.set(kind, part)
    }
    const id = itemId(kind, tag, name)
    let entry = part.get(id)
    if (!entry) {
      entry = { id, name, tag: tag || undefined, n: 0, tokens: 0, pieces: [] }
      part.set(id, entry)
    }
    entry.n++
    entry.tokens += tokens
    if (this.keep) entry.pieces.push(piece)
  }
  chat(tokens: number, piece: ContextPiece): void {
    if (!this.turn) this.turn = 1
    this.add('chat', String(this.turn), 'turn', tokens, piece)
  }
  splitMemory(text: string): string {
    const sections = [
      ...[...text.matchAll(contentsOf)].map((m) => ({ at: m.index!, path: m[1], desc: m[2] })),
      ...[...text.matchAll(instructionsFrom)].map((m) => ({
        at: m.index!,
        path: m[1].replace(/[ \t]+$/, ''),
        desc: '',
      })),
    ].sort((a, b) => a.at - b.at)
    if (!sections.length) return text
    let rest = text.slice(0, sections[0].at)
    sections.forEach((section, i) => {
      let chunk = text.slice(section.at, sections[i + 1]?.at ?? text.length)
      const end = chunk.indexOf('</system-reminder>')
      if (end >= 0) {
        rest += chunk.slice(end)
        chunk = chunk.slice(0, end)
      }
      this.add('memory', section.path, memoryTag(section.path, section.desc), tokensOf(chunk), textPiece('', chunk))
    })
    return rest
  }
  splitSkills(text: string, role: ContextPiece['role']): string {
    const at = text.indexOf(skillsList)
    if (at < 0) return text
    const body = text.slice(at + skillsList.length)
    const items = body.replace(/^\n+/, '')
    const blank = items.indexOf('\n\n')
    const end = blank >= 0 ? text.length - items.length + blank : text.length
    const list = text.slice(at, end)
    this.add('skills', 'skills', 'skills', tokensOf(list), textPiece(role, list))
    return text.slice(0, at) + text.slice(end).replace(/^\n+/, '')
  }
  systemText(text: string, name = 'prompt'): void {
    const rest = this.splitSkills(this.splitMemory(text), 'system')
    if (rest.trim().startsWith('<skills_instructions>')) {
      this.add('skills', 'skills', 'skills', tokensOf(rest), textPiece('system', rest))
    } else if (rest.trim()) this.add('system', harnessName(rest, name), '', tokensOf(rest), textPiece('system', rest))
  }
  userText(text: string): void {
    const trimmed = text.trim()
    if (trimmed.startsWith('<app_memory>')) {
      this.add('memory', 'Pi meme 记忆', 'memory', tokensOf(text), textPiece('user', text))
      return
    }
    if (trimmed.startsWith('<system-reminder>')) {
      const rest = this.splitSkills(this.splitMemory(trimmed), 'user')
        .trim()
        .replace(/^<system-reminder>/, '')
        .replace(/<\/system-reminder>$/, '')
        .trim()
      if (rest) this.add('memory', 'reminders', 'reminder', tokensOf(rest), textPiece('user', rest))
      return
    }
    const agents = agentsFor.exec(trimmed)
    if (agents) {
      this.add(
        'memory',
        `${agents[2].replace(/[ \t]+$/, '').replace(/\/+$/, '')}/${agents[1]}`,
        'project',
        tokensOf(trimmed),
        textPiece('user', trimmed),
      )
      return
    }
    if (
      ['<environment_context>', '<user_instructions>', '<turn_aborted>', '<user_shell_command>'].some((tag) =>
        trimmed.startsWith(tag),
      )
    ) {
      this.add('system', harnessName(trimmed, 'context'), '', tokensOf(trimmed), textPiece('user', trimmed))
      return
    }
    this.chat(tokensOf(text), textPiece('user', text))
  }
  result(callId: string, tokens: number, piece: ContextPiece): void {
    const call = this.calls.get(callId) || { name: 'tool', files: [] }
    piece.name ||= call.name
    if (call.files.length) {
      const each = Math.floor(tokens / call.files.length)
      call.files.forEach((file, index) =>
        this.add(
          'files',
          file,
          readTools.has(call.name) ? 'read' : 'shell',
          each + (index ? 0 : tokens - each * call.files.length),
          piece,
        ),
      )
    } else this.add('results', call.name, 'result', tokens, piece)
  }
  tool(name: string, definition: unknown): void {
    const piece = this.rawPiece('tool', name, definition)
    if (name.startsWith('mcp__'))
      this.add('tools', name.slice(5).split('__')[0], 'mcp', this.rawTokens(definition), piece)
    else this.add('tools', name, '', this.rawTokens(definition), piece)
  }
  responsesTool(value: unknown): void {
    const tool = object(value)
    let name = string(tool.name) || string(object(tool.function).name) || string(tool.type)
    const tools = array(tool.tools)
    if (tool.type === 'namespace' || tools.length) {
      if (name === 'functions') {
        tools.forEach((entry) => this.responsesTool(entry))
        return
      }
      const tag = name.startsWith('mcp__') ? 'mcp' : 'namespace'
      if (tag === 'mcp') name = name.slice(5).split('__')[0].replace(/_+$/, '')
      this.add('tools', name, tag, this.rawTokens(value), this.rawPiece('tool', name, value))
      const item = this.parts.get('tools')?.get(itemId('tools', tag, name))
      if (item) item.n += tools.length - 1
    } else this.tool(name, value)
  }
  anthropic(request: ObjectValue): void {
    for (const part of blocks(request.system)) {
      const text = string(part.text)
      if (text.startsWith('x-anthropic-billing-header'))
        this.add('system', 'billing', '', tokensOf(text), textPiece('system', text))
      else this.systemText(text)
    }
    for (const tool of array(request.tools)) this.tool(string(object(tool).name), tool)
    for (const value of array(request.messages)) {
      const message = object(value)
      const role = string(message.role)
      const parts = blocks(message.content)
      if (role === 'system' || role === 'developer') {
        parts.forEach((part) => this.systemText(string(part.text), 'harness'))
        continue
      }
      if (
        role === 'user' &&
        !parts.some((part) => part.type === 'tool_result') &&
        parts.some((part) => part.type === 'text' && userSays(string(part.text)))
      )
        this.turn++
      for (const part of parts) this.anthropicBlock(role, part)
    }
  }
  anthropicBlock(role: string, part: ObjectValue): void {
    const text = string(part.text)
    switch (part.type) {
      case 'text':
        if (role === 'user') this.userText(text)
        else this.chat(tokensOf(text), textPiece(role === 'assistant' ? 'assistant' : '', text))
        break
      case 'thinking':
        this.chat(tokensOf(string(part.thinking)), textPiece('thinking', string(part.thinking)))
        break
      case 'redacted_thinking':
        this.chat(Math.floor(tokensOf(string(part.data)) / 4), sealedPiece(bytes(string(part.data))))
        break
      case 'tool_use':
      case 'server_tool_use': {
        const name = string(part.name)
        this.calls.set(string(part.id), callOf(name, part.input))
        this.chat(tokensOf(name) + this.rawTokens(part.input), this.rawPiece('call', name, part.input))
        break
      }
      case 'tool_result':
      case 'web_search_tool_result':
      case 'web_fetch_tool_result': {
        let tokens = 0
        const texts: string[] = []
        for (const content of blocks(part.content)) {
          if (content.type === 'image' || content.type === 'document')
            this.add('files', string(content.type), 'image', imageTokens, this.image(content.source))
          else {
            tokens += tokensOf(string(content.text))
            texts.push(string(content.text))
          }
        }
        let piece = textPiece('result', texts.join('\n'))
        if (part.content !== undefined && typeof part.content !== 'string' && !Array.isArray(part.content)) {
          tokens = this.rawTokens(part.content)
          piece = this.rawPiece('result', '', part.content)
        }
        this.result(string(part.tool_use_id), tokens, piece)
        break
      }
      case 'image':
      case 'document':
        if (part.type === 'document' && part.source !== undefined && !this.raw(part.source).includes('"base64"'))
          this.add('files', 'document', 'image', this.rawTokens(part.source), this.rawPiece('', '', part.source))
        else this.add('files', string(part.type), 'image', imageTokens, this.image(part.source))
        break
      default:
        this.chat(tokensOf(text), textPiece(role === 'user' || role === 'assistant' ? role : '', text))
    }
  }
  responses(request: ObjectValue): void {
    this.held = !!string(request.previous_response_id)
    if (typeof request.instructions === 'string') this.systemText(request.instructions)
    array(request.tools).forEach((tool) => this.responsesTool(tool))
    if (typeof request.input === 'string') {
      this.turn++
      this.userText(request.input)
      return
    }
    array(request.input).forEach((item) => this.responsesItem(object(item)))
  }
  responsesItem(item: ObjectValue): void {
    const type = string(item.type) || (item.role ? 'message' : '')
    switch (type) {
      case 'additional_tools':
        array(item.tools).forEach((tool) => this.responsesTool(tool))
        break
      case 'message':
        this.message(string(item.role), item.content)
        break
      case 'reasoning': {
        const texts = array(item.summary).map((summary) => string(object(summary).text))
        const encrypted = string(item.encrypted_content)
        const piece = textPiece('thinking', texts.join('\n\n'))
        if (encrypted) piece.size = bytes(encrypted)
        this.chat(
          texts.reduce((sum, text) => sum + tokensOf(text), 0) + Math.floor((bytes(encrypted) * 3) / 4 / 4),
          piece,
        )
        break
      }
      case 'function_call':
      case 'custom_tool_call':
      case 'local_shell_call':
      case 'tool_search_call': {
        const name = string(item.name)
        const input =
          type === 'custom_tool_call'
            ? string(item.input)
            : type === 'local_shell_call'
              ? this.raw(item.action)
              : string(item.arguments)
        this.calls.set(string(item.call_id), callOf(name, input))
        this.chat(tokensOf(name) + Math.ceil(bytes(input) / 4), this.rawPiece('call', name, input, true))
        break
      }
      case 'function_call_output':
      case 'custom_tool_call_output':
      case 'local_shell_call_output':
      case 'tool_search_output': {
        let tokens = 0
        let text = ''
        if (typeof item.output === 'string') {
          text = item.output
          tokens = tokensOf(text)
        } else {
          const texts: string[] = []
          for (const part of responseContent(item.output)) {
            if (part.image) this.add('files', 'image', 'image', imageTokens, this.image(part.source))
            else {
              tokens += tokensOf(part.text)
              texts.push(part.text)
            }
          }
          text = texts.join('\n')
        }
        if (type === 'tool_search_output') array(item.tools).forEach((tool) => this.responsesTool(tool))
        this.result(string(item.call_id), tokens, textPiece('result', text))
        break
      }
      case 'compaction':
      case 'compaction_summary':
        this.add('chat', 'compacted', 'compacted', this.rawTokens(item), sealedPiece(bytes(this.raw(item))))
        break
      default:
        this.chat(this.rawTokens(item), this.rawPiece('', type, item))
    }
  }
  message(role: string, content: unknown): void {
    const parts = responseContent(content)
    if (role === 'system' || role === 'developer') {
      parts.forEach((part) => this.systemText(part.text))
      return
    }
    if (role === 'user') {
      if (parts.some((part) => part.image || userSays(part.text))) this.turn++
      for (const part of parts) {
        if (part.image) this.add('files', 'image', 'image', imageTokens, this.image(part.source))
        else this.userText(part.text)
      }
    } else for (const part of parts) this.chat(tokensOf(part.text), textPiece('assistant', part.text))
  }
  completions(request: ObjectValue): void {
    array(request.tools).forEach((tool) => this.responsesTool(tool))
    for (const value of array(request.messages)) {
      const message = object(value)
      const role = string(message.role)
      if (['system', 'developer', 'user'].includes(role)) {
        this.message(role, message.content)
        continue
      }
      const parts = responseContent(message.content)
      const texts: string[] = []
      let tokens = 0
      for (const part of parts) {
        if ((role === 'tool' || role === 'function') && part.image)
          this.add('files', 'image', 'image', imageTokens, this.image(part.source))
        else {
          tokens += tokensOf(part.text)
          texts.push(part.text)
        }
      }
      if (role === 'tool' || role === 'function')
        this.result(string(message.tool_call_id), tokens, textPiece('result', texts.join('\n')))
      else {
        this.chat(tokensOf(string(message.reasoning_content)), textPiece('thinking', string(message.reasoning_content)))
        this.chat(tokens, textPiece('assistant', texts.join('\n')))
        for (const value of array(message.tool_calls)) {
          const call = object(value)
          const fn = object(call.function)
          const name = string(fn.name)
          const input = string(fn.arguments)
          this.calls.set(string(call.id), callOf(name, input))
          this.chat(tokensOf(name) + tokensOf(input), this.rawPiece('call', name, input, true))
        }
      }
    }
  }
  gemini(request: ObjectValue): void {
    array(object(request.systemInstruction).parts).forEach((part) => this.systemText(string(object(part).text)))
    for (const tool of array(request.tools))
      for (const declaration of array(object(tool).functionDeclarations))
        this.tool(string(object(declaration).name), declaration)
    for (const value of array(request.contents)) {
      const content = object(value)
      const parts = array(content.parts).map(object)
      if (content.role !== 'model' && parts.some((part) => userSays(string(part.text)) && !part.functionResponse))
        this.turn++
      for (const part of parts) {
        if (part.functionCall) {
          const call = object(part.functionCall)
          const name = string(call.name)
          this.calls.set(string(call.id) || `name:${name}`, callOf(name, call.args))
          this.chat(tokensOf(name) + this.rawTokens(call.args), this.rawPiece('call', name, call.args))
        } else if (part.functionResponse) {
          const response = object(part.functionResponse)
          const id = string(response.id) || `name:${string(response.name)}`
          if (!this.calls.has(id)) this.calls.set(id, { name: string(response.name), files: [] })
          this.result(id, this.rawTokens(response.response), this.rawPiece('result', '', response.response))
        } else if (part.inlineData !== undefined || part.fileData !== undefined)
          this.add('files', 'image', 'image', imageTokens, this.image(part.inlineData))
        else if (content.role === 'model')
          this.chat(tokensOf(string(part.text)), textPiece(part.thought ? 'thinking' : 'assistant', string(part.text)))
        else this.userText(string(part.text))
      }
    }
  }
  items(kind: ContextPartKind): ContextTextItem[] {
    const items = [...(this.parts.get(kind)?.values() || [])].map(({ n, ...item }) => ({
      ...item,
      n: n > 1 && ['mcp', 'namespace', 'result'].includes(item.tag || '') ? n : undefined,
    }))
    if (kind === 'chat')
      return items.sort((a, b) => {
        const x = Number(a.name)
        const y = Number(b.name)
        return Number.isNaN(x) ? (Number.isNaN(y) ? compareNames(a, b) : -1) : Number.isNaN(y) ? 1 : x - y
      })
    return items.sort(bySize)
  }
  prompt(window?: number): ContextPrompt {
    const prompt: ContextPrompt = {
      tokens: 0,
      counted: false,
      held: this.held || undefined,
      turns: this.turn,
      parts: [],
    }
    if (window && Number.isFinite(window) && window > 0) prompt.window = window
    for (const kind of contextPartKinds) {
      let items: ContextPromptItem[] = this.items(kind).map(({ pieces: _pieces, ...item }) => item)
      if (!items.length) continue
      const tokens = items.reduce((sum, item) => sum + item.tokens, 0)
      if (items.length > summaryItems) {
        const earlier = kind === 'chat'
        const rest = earlier ? items.slice(0, items.length - summaryItems + 1) : items.slice(summaryItems - 1)
        const name = earlier ? 'earlier' : 'other'
        const tag = earlier ? 'turns' : 'more'
        const merged = {
          id: itemId(kind, tag, name),
          name,
          tag,
          n: rest.length,
          tokens: rest.reduce((sum, item) => sum + item.tokens, 0),
        }
        items = earlier
          ? [merged, ...items.slice(items.length - summaryItems + 1)]
          : [...items.slice(0, summaryItems - 1), merged]
      }
      prompt.tokens += tokens
      prompt.parts.push({ kind, tokens, items })
    }
    return prompt
  }
}

function builder(api: string, body: string, keep: boolean): PromptBuilder | undefined {
  try {
    const { value, raw } = decode(body)
    const result = new PromptBuilder(raw, keep)
    switch (api) {
      case 'anthropic-messages':
      case 'anthropic':
        result.anthropic(value)
        break
      case 'openai-completions':
      case 'openai-chat-completions':
      case 'chat':
        result.completions(value)
        break
      case 'openai-responses':
      case 'openai-codex-responses':
      case 'responses':
        result.responses(value)
        break
      case 'google-generative-ai':
      case 'google-vertex':
      case 'gemini':
        result.gemini(value)
        break
      default:
        return undefined
    }
    return result
  } catch {
    return undefined
  }
}

/** Request summary only; no prompt text is retained in the returned value. */
export function inspectPrompt(api: string, body: string, window?: number): ContextPrompt | undefined {
  return builder(api, body, false)?.prompt(window)
}

/** Full item index, independent of the summary's 24-item aggregation. */
export function promptItems(api: string, body: string, kind: ContextPartKind): ContextTextItem[] {
  if (!contextPartKinds.includes(kind)) return []
  return builder(api, body, true)?.items(kind) || []
}

// Keep rounding local to the largest entries, but never deduct more than an
// entry holds. Magpie's single-largest correction can make a part negative
// when a very small vendor count is spread over many parts.
function alignTokens(entries: { tokens: number }[], total: number): void {
  let delta = total - entries.reduce((sum, entry) => sum + entry.tokens, 0)
  const largestFirst = entries.slice().sort((a, b) => b.tokens - a.tokens)
  if (delta > 0 && largestFirst.length) largestFirst[0].tokens += delta
  else if (delta < 0) {
    for (const entry of largestFirst) {
      const take = Math.min(entry.tokens, -delta)
      entry.tokens -= take
      delta += take
      if (!delta) break
    }
  }
}

/** Full-text item sizes use the same global ratio as the request summary. */
export function scalePromptItems(
  items: ContextTextItem[],
  counted: number,
  estimated: number,
  partTokens?: number,
): ContextTextItem[] {
  const result = items.map((item) => ({ ...item, pieces: item.pieces.map((piece) => ({ ...piece })) }))
  if (!Number.isFinite(counted) || counted < 0 || !Number.isFinite(estimated) || estimated <= 0) return result
  const scale = counted / estimated
  for (const item of result) item.tokens = Math.max(0, Math.round(item.tokens * scale))
  const total =
    partTokens !== undefined && Number.isFinite(partTokens) && partTokens >= 0
      ? Math.round(partTokens)
      : Math.round(items.reduce((sum, item) => sum + item.tokens, 0) * scale)
  alignTokens(result, total)
  return result
}

/** Copy-on-write calibration to vendor input, including cache read/write. */
export function calibratePrompt(prompt: ContextPrompt, counted: number, window?: number): ContextPrompt {
  const result: ContextPrompt = {
    ...prompt,
    parts: prompt.parts.map((part) => ({ ...part, items: part.items.map((item) => ({ ...item })) })),
  }
  if (window && Number.isFinite(window) && window > 0) result.window = window
  if (!Number.isFinite(counted) || counted <= 0 || prompt.counted || prompt.tokens <= 0 || !result.parts.length)
    return result
  counted = Math.round(counted)
  const scale = counted / prompt.tokens
  for (const part of result.parts) {
    part.tokens = Math.round(part.tokens * scale)
    for (const item of part.items) item.tokens = Math.round(item.tokens * scale)
  }
  alignTokens(result.parts, counted)
  for (const part of result.parts) alignTokens(part.items, part.tokens)
  result.tokens = counted
  result.counted = true
  return result
}
