export function completionQuery(draft: string, caret: number) {
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
  const command = before.match(/^\s*\/(\S*)$/)
  return command ? { kind: 'command' as const, query: command[1], start: before.indexOf('/') } : null
}
