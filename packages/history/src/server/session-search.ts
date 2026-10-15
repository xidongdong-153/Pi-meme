import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import type { PiMessage } from '@pi-meme/contracts/pi'
import { skillMessageText } from '@pi-meme/contracts/skills'

export function sessionSearchExcerpt(message: unknown, query: string): string | undefined {
  if (!message || typeof message !== 'object') return
  const value = message as Partial<PiMessage>
  if (value.role !== 'user' && value.role !== 'assistant') return
  const content = value.content
  const text = skillMessageText(
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.flatMap((part) => (part.type === 'text' && typeof part.text === 'string' ? [part.text] : [])).join('')
        : '',
  ).replace(/\s+/g, ' ')
  const index = text.toLocaleLowerCase().indexOf(query)
  if (index < 0) return
  const start = Math.max(0, index - 60)
  const end = Math.min(text.length, index + query.length + 100)
  return `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

export async function searchSessionFile(filename: string, query: string): Promise<string | undefined> {
  const input = createReadStream(filename, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Infinity })
  let hasHeader = false
  try {
    for await (const line of lines) {
      let entry: { type?: string; message?: unknown }
      try {
        const parsed: unknown = JSON.parse(line)
        if (!parsed || typeof parsed !== 'object') continue
        entry = parsed
      } catch {
        continue
      }
      if (entry.type === 'session') hasHeader = true
      if (!hasHeader || entry.type !== 'message') continue
      const excerpt = sessionSearchExcerpt(entry.message, query)
      if (excerpt !== undefined) return excerpt
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
  } finally {
    lines.close()
    input.destroy()
  }
}
