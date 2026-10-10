export interface ParsedCompactionSummary {
  goal?: string
  progress?: string
  detailsMarkdown?: string
  readFiles: string[]
  modifiedFiles: string[]
  rawSummary: string
  isStructured: boolean
}

function parseFileList(tag: string, content: string): string[] {
  const match = content.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  if (!match || !match[1]) return []
  return match[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => Boolean(line) && !line.startsWith('#'))
}

/**
 * 解析 Pi 上下文压缩摘要（Compaction Summary）与分支摘要（Branch Summary）
 * 提取核心目标（Goal）、当前进度（Progress）、文件操作清单与后续细节。
 */
export function parseCompactionSummary(summary: string): ParsedCompactionSummary {
  const rawSummary = summary || ''
  const readFiles = parseFileList('read-files', rawSummary)
  const modifiedFiles = parseFileList('modified-files', rawSummary)

  const cleanText = rawSummary
    .replace(/<read-files>[\s\S]*?<\/read-files>/gi, '')
    .replace(/<modified-files>[\s\S]*?<\/modified-files>/gi, '')
    .trim()

  if (!cleanText) {
    return {
      readFiles,
      modifiedFiles,
      rawSummary,
      isStructured: readFiles.length > 0 || modifiedFiles.length > 0,
    }
  }

  // 逐行切分二级标题，避免超线性回溯正则表达式
  const sections: Array<{ title: string; content: string }> = []
  let currentSection: { title: string; lines: string[] } | null = null

  for (const line of cleanText.split('\n')) {
    if (line.startsWith('## ')) {
      currentSection = { title: line.slice(3).trim(), lines: [] }
      sections.push({ title: currentSection.title, content: '' })
    } else if (currentSection) {
      currentSection.lines.push(line)
      sections[sections.length - 1]!.content = currentSection.lines.join('\n').trim()
    }
  }

  let goal: string | undefined
  let progress: string | undefined
  const otherSections: Array<{ title: string; content: string }> = []

  for (const section of sections) {
    const lowerTitle = section.title.toLowerCase()
    if (!goal && (lowerTitle.includes('goal') || lowerTitle.includes('目标'))) {
      goal = section.content
    } else if (!progress && (lowerTitle.includes('progress') || lowerTitle.includes('进度'))) {
      progress = section.content
    } else {
      otherSections.push(section)
    }
  }

  const isStructured = Boolean(goal || progress)
  const detailsMarkdown = isStructured
    ? otherSections
        .map((s) => `## ${s.title}\n\n${s.content}`)
        .join('\n\n')
        .trim()
    : cleanText

  return {
    goal,
    progress,
    detailsMarkdown: detailsMarkdown || undefined,
    readFiles,
    modifiedFiles,
    rawSummary,
    isStructured,
  }
}
