import { mcpReferences } from '@pi-meme/contracts/mcp'

export const computerMention = '@[电脑]'

export function composerReferences(text: string) {
  const files = [...text.matchAll(/(?:^|[\s\uFFFC])(@"([^"\n]+)"|@\[电脑\])/gu)].map((match) => ({
    text: match[1],
    computer: match[1] === computerMention,
    mcp: undefined as string | undefined,
    path: match[2] ?? '',
    start: match.index + match[0].length - match[1].length,
    end: match.index + match[0].length,
  }))
  const servers = mcpReferences(text)
    .filter((ref) => !files.some((file) => file.start <= ref.start && file.end > ref.start))
    .map((ref) => ({ ...ref, computer: false, path: '', mcp: ref.name }))
  return [...files, ...servers].sort((a, b) => a.start - b.start)
}

export function fileReferences(text: string) {
  return composerReferences(text)
    .filter((ref) => !ref.computer && !ref.mcp)
    .map(({ text, path, start, end }) => ({ text, path, start, end }))
}

export function completionQuery(draft: string, caret: number) {
  if (composerReferences(draft).some((reference) => caret > reference.start && caret <= reference.end)) return null
  const before = draft.slice(0, caret)
  const file = before.match(/(?:^|\s|\uFFFC)(@"([^"]*)|@([^\s"@]*))$/)
  if (file)
    return {
      kind: 'file' as const,
      query: file[3] ?? file[2],
      start: before.length - file[1].length,
      quoted: file[2] !== undefined,
    }
  const skill = before.match(/(?:^|\s|\uFFFC)\$([^\s$]*)$/)
  if (skill) return { kind: 'skill' as const, query: skill[1], start: before.lastIndexOf('$') }
  const command = before.match(/(?:^|\s|\uFFFC)\/([^\s/]*)$/)
  return command ? { kind: 'command' as const, query: command[1], start: before.lastIndexOf('/') } : null
}
