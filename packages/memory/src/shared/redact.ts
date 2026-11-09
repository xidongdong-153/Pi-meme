/** SDK-expanded instruction blocks are context, never user evidence. Native revisions stay unchanged. */
export function stripMemoryContext(value: string): string {
  return value.replace(/<(skill|system-reminder)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '').trim()
}

/** Strip recognizable credentials before durable task/source excerpts or model input. */
export function redactMemoryText(value: string): string {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
    .replace(/\bBearer\s+[\w.~+/=-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|pk|ghp|gho|github_pat|xox[baprs])[-_][\w-]{12,}/g, '[REDACTED TOKEN]')
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, '[REDACTED ACCESS KEY]')
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|authorization|secret)[ \t]{0,16}(?:["'][ \t]{0,16})?[:=][ \t]{0,16}["']?)[^\s"'&,;]{4,}/gi,
      '$1[REDACTED]',
    )
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
}
