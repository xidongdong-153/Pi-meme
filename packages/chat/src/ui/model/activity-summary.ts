import type { ActivityItem, RenderSegment } from './types'
import { parseToolMeta, type ToolKind } from './tool-details'
import { getThinkingLabel } from './thinking-labels'

export function groupAdjacentActivities(items: ActivityItem[], finalText = ''): RenderSegment[] {
  const groups: RenderSegment[] = []
  const appendText = (text: string) => {
    if (!text.trim()) return
    const previous = groups.at(-1)
    if (previous?.type === 'text') previous.text += `\n\n${text}`
    else groups.push({ type: 'text', text })
  }
  for (const item of items) {
    if (item.type === 'narration') {
      appendText(item.text)
      continue
    }
    const previous = groups.at(-1)
    if (previous?.type === 'activity') previous.items.push(item)
    else groups.push({ type: 'activity', items: [item] })
  }
  appendText(finalText)
  return groups
}

export function formatDurationChinese(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 1000) return ''
  const totalSeconds = Math.round(durationMs / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) {
    const minPart = minutes > 0 ? `${minutes}分 ` : ''
    return `${hours}小时 ${minPart}${seconds}秒`
  }
  if (minutes > 0) {
    const secPart = seconds > 0 ? `${seconds}秒` : ''
    return `${minutes}分 ${secPart}`
  }
  return `${seconds}秒`
}

export function summarizeActivities(items: ActivityItem[]): {
  summary: string
  kind: ToolKind | 'thinking'
} {
  let hasThought = false
  const readPaths = new Set<string>()
  const editPaths = new Set<string>()
  const createPaths = new Set<string>()
  let readPathless = 0
  let editPathless = 0
  let createPathless = 0
  let commandCount = 0
  let searchCount = 0
  let imageCount = 0
  let generatedCount = 0
  let editedImageCount = 0
  let imageFailureCount = 0
  let otherCount = 0

  for (const item of items) {
    if (item.type === 'thinking') {
      hasThought = true
      continue
    }
    if (item.type === 'narration') {
      continue
    }
    const meta = parseToolMeta(item)
    if (meta.kind === 'command') {
      commandCount++
    } else if (meta.kind === 'search') {
      searchCount++
    } else if (meta.kind === 'image-generation') {
      if (item.status === 'error') imageFailureCount++
      else if (item.status === 'success') {
        if (meta.summary === '已编辑图片') editedImageCount++
        else generatedCount++
      }
    } else if (meta.kind === 'image') {
      imageCount++
    } else if (meta.kind === 'read') {
      if (meta.fullPath) readPaths.add(meta.fullPath)
      else readPathless++
    } else if (meta.kind === 'edit') {
      if (meta.fullPath) editPaths.add(meta.fullPath)
      else editPathless++
    } else if (meta.kind === 'write') {
      if (meta.fullPath) createPaths.add(meta.fullPath)
      else createPathless++
    } else {
      otherCount++
    }
  }

  const readFileTotal = readPaths.size + readPathless
  const editFileTotal = editPaths.size + editPathless
  const createFileTotal = createPaths.size + createPathless

  const parts: string[] = []
  if (readFileTotal > 0) parts.push(`读取了 ${readFileTotal} 个文件`)
  if (createFileTotal > 0) parts.push(`创建了 ${createFileTotal} 个文件`)
  if (editFileTotal > 0) parts.push(`编辑了 ${editFileTotal} 个文件`)
  if (imageCount > 0) parts.push(`查看了 ${imageCount} 张图像`)
  if (generatedCount > 0) parts.push(`生成了 ${generatedCount} 张图片`)
  if (editedImageCount > 0) parts.push(`编辑了 ${editedImageCount} 张图片`)
  if (imageFailureCount > 0) parts.push(`图片处理失败 ${imageFailureCount} 次`)
  if (searchCount > 0) parts.push(`在代码中搜索了 ${searchCount} 次`)
  if (commandCount > 0) parts.push(`执行了 ${commandCount} 条命令`)
  if (otherCount > 0) parts.push(`调用了 ${otherCount} 项工具`)

  let kind: ToolKind | 'thinking' = 'generic'
  if (hasThought && items.length === 1) kind = 'thinking'
  else if (generatedCount + editedImageCount + imageFailureCount > 0) kind = 'image-generation'
  else if (commandCount > 0 && readFileTotal === 0 && editFileTotal === 0 && createFileTotal === 0 && imageCount === 0)
    kind = 'command'
  else if (readFileTotal > 0 && editFileTotal === 0 && createFileTotal === 0 && imageCount === 0) kind = 'read'
  else if (editFileTotal > 0 || createFileTotal > 0) kind = 'edit'
  else if (imageCount > 0 && readFileTotal === 0 && editFileTotal === 0 && createFileTotal === 0) kind = 'image'
  else if (searchCount > 0) kind = 'search'
  else if (hasThought) kind = 'thinking'

  return {
    summary: parts.join(' · '),
    kind,
  }
}

export function runningActivityLabel(items: ActivityItem[]): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    if (item.type === 'narration') continue
    if (item.status === 'running') {
      if (item.type === 'thinking') return getThinkingLabel(item.id)
      if (item.name === 'request_user_input') return '等待你的回答…'
      const meta = parseToolMeta(item)
      if (meta.kind === 'image-generation') return meta.summary === '已编辑图片' ? '正在编辑图片…' : '正在生成图片…'
      if (meta.kind === 'command')
        return meta.summary.startsWith('已运行 ') ? `${meta.summary.replace(/^已运行/u, '正在运行')}…` : '正在运行命令…'
      if (meta.kind === 'image') return '正在查看图像…'
      if (meta.kind === 'read') return `${meta.summary.replace('已读取', '正在读取')}…`
      if (meta.kind === 'edit') return `${meta.summary.replace('已编辑', '正在编辑').replace('已修改', '正在修改')}…`
      if (meta.kind === 'write') return `${meta.summary.replace('已创建', '正在创建')}…`
      if (meta.kind === 'search') return '正在搜索…'
      return item.name ? `正在执行 ${item.name}…` : '正在执行工具…'
    }
  }
  return '正在处理…'
}
