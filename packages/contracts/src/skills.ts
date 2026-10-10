export const skillMarker = '\uFFFC'
export type SkillReference = { name: string }

export type SkillMessagePart = { type: 'text'; text: string } | { type: 'skill'; name: string; path: string }

function decodeAttribute(value: string) {
  return value.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
}

/** 把展开后的技能正文解析成文本与技能引用，供界面摘要和标题使用。 */
export function skillMessageParts(text: string): SkillMessagePart[] {
  const parts: SkillMessagePart[] = []
  const pattern = /<skill name="([^"]+)" location="([^"]+)">[\s\S]*?<\/skill>/g
  let start = 0
  for (const match of text.matchAll(pattern)) {
    if (match.index > start) parts.push({ type: 'text', text: text.slice(start, match.index) })
    parts.push({ type: 'skill', name: decodeAttribute(match[1]), path: decodeAttribute(match[2]) })
    start = match.index + match[0].length
  }
  if (start < text.length) parts.push({ type: 'text', text: text.slice(start) })
  return parts
}

export function skillMessageText(text: string): string {
  return skillMessageParts(text)
    .map((part) => (part.type === 'text' ? part.text : `$${part.name}`))
    .join('')
}
