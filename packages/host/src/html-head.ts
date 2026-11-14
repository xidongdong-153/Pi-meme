/** 找到真正的 head 结束位置；注释、属性和原始文本里的示例标签不算边界。 */
export function htmlHeadEnd(html: string): number | undefined {
  let offset = 0
  while (offset < html.length) {
    const start = html.indexOf('<', offset)
    if (start < 0) return undefined
    if (html.startsWith('<!--', start)) {
      const end = html.indexOf('-->', start + 4)
      if (end < 0) return undefined
      offset = end + 3
      continue
    }
    if (html.startsWith('<![CDATA[', start)) {
      const end = html.indexOf(']]>', start + 9)
      if (end < 0) return undefined
      offset = end + 3
      continue
    }
    const tag = /^<(\/?)([a-z][\w:-]*)(?=[\s/>])/i.exec(html.slice(start))
    if (!tag && !/^<[!?]/.test(html.slice(start, start + 2))) {
      offset = start + 1
      continue
    }
    let quote = ''
    let end = start + (tag?.[0].length ?? 2)
    for (; end < html.length; end++) {
      const char = html[end]
      if (quote) {
        if (char === quote) quote = ''
      } else if (char === '"' || char === "'") quote = char
      else if (char === '>') break
    }
    // 不完整的标签、注释或原始文本块继续等待下一个数据块。
    if (end === html.length) return undefined
    const name = tag?.[2].toLowerCase()
    if ((tag?.[1] && name === 'head') || (!tag?.[1] && name === 'body')) return start
    offset = end + 1
    if (!tag?.[1] && name && /^(?:script|style|title|textarea|noscript)$/.test(name)) {
      const close = new RegExp(`</${name}\\s*>`, 'gi')
      close.lastIndex = offset
      const match = close.exec(html)
      if (!match) return undefined
      offset = match.index + match[0].length
    }
  }
  return undefined
}
