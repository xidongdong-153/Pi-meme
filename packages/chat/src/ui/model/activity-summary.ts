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

function flattenActivities(item: ActivityItem): ActivityItem[] {
  return item.type === 'thinking' || item.type === 'narration'
    ? [item]
    : [item, ...(item.children ?? []).flatMap(flattenActivities)]
}

const activityActions: Record<ToolKind | 'thinking', string> = {
  command: '运行命令',
  read: '读取文件',
  write: '创建文件',
  edit: '编辑文件',
  image: '查看图片',
  'image-generation': '生成图片',
  search: '搜索内容',
  generic: '使用工具',
  thinking: '思考',
}

function activityAction(item: ActivityItem): string {
  const meta = parseToolMeta(item)
  if (item.type !== 'thinking' && item.type !== 'narration') {
    if (item.name === 'request_user_input') return '向你提问'
    if (item.name === 'codemode') return '执行脚本'
  }
  if (meta.kind === 'image-generation' && meta.summary === '已编辑图片') return '编辑图片'
  return activityActions[meta.kind]
}

export function summarizeActivities(
  items: ActivityItem[],
  isLive = false,
  isPaused = false,
): {
  summary: string
  kind: ToolKind | 'thinking'
  status: 'running' | 'waiting' | 'paused' | 'error' | 'complete'
} {
  const activities = items.flatMap(flattenActivities)
  if (isLive) {
    const item =
      activities.findLast((entry) => entry.status === 'running') ??
      activities.findLast((entry) => entry.type !== 'thinking' && entry.type !== 'narration') ??
      activities.findLast((entry) => entry.type === 'thinking')
    const kind = item ? parseToolMeta(item).kind : 'thinking'
    if (isPaused) return { summary: '已暂停，等待继续', kind, status: 'paused' }
    if (!item) return { summary: '正在处理…', kind, status: 'running' }
    if (item.status === 'running') {
      const waiting = item.type !== 'thinking' && item.name === 'request_user_input'
      return {
        summary: item.type === 'thinking' ? '正在思考…' : runningActivityLabel([item]),
        kind,
        status: waiting ? 'waiting' : 'running',
      }
    }
    if (item.status === 'error') return { summary: `${activityAction(item)}失败`, kind, status: 'error' }
    return {
      summary: item.type === 'thinking' ? '思考过程' : `已${activityAction(item)}`,
      kind,
      status: 'complete',
    }
  }

  const actions = new Set<string>()
  const kinds = new Set<ToolKind | 'thinking'>()
  let failed: ActivityItem | undefined
  for (const item of activities) {
    if (item.type === 'thinking' || item.type === 'narration') continue
    if (item.status === 'error') failed = item
    if (item.children?.length) continue
    const meta = parseToolMeta(item)
    kinds.add(meta.kind)
    if (item.status === 'error') continue
    const action = activityAction(item)
    actions.add(meta.kind === 'image-generation' && item.status !== 'success' ? `尝试${action}` : action)
  }

  const kind =
    kinds.size === 0
      ? 'thinking'
      : kinds.size === 1
        ? [...kinds][0]!
        : kinds.has('edit') || kinds.has('write')
          ? 'edit'
          : 'generic'
  const parts = [...actions]
  if (parts.length === 0) {
    return {
      summary: failed ? `${activityAction(failed)}失败` : '思考过程',
      kind,
      status: failed ? 'error' : 'complete',
    }
  }
  const target = ['文件', '图片'].find((value) => parts.every((part) => part.endsWith(value)))
  const phrases = target ? parts.map((part) => part.slice(0, -target.length)) : parts
  const summary =
    parts.length > 3
      ? `已完成${parts.slice(0, 3).join('、')}等操作`
      : `已${phrases.length === 1 ? phrases[0] : `${phrases.slice(0, -1).join('、')}并${phrases.at(-1)}`}${target ?? ''}`
  return {
    summary: failed ? `${summary}，部分操作失败` : summary,
    kind,
    status: failed ? 'error' : 'complete',
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
      if (meta.kind === 'image')
        return meta.fullPath ? `${meta.summary.replace('已查看', '正在查看')}…` : '正在查看图像…'
      if (meta.kind === 'read') return `${meta.summary.replace('已读取', '正在读取')}…`
      if (meta.kind === 'edit') return `${meta.summary.replace('已编辑', '正在编辑').replace('已修改', '正在修改')}…`
      if (meta.kind === 'write') return `${meta.summary.replace('已创建', '正在创建')}…`
      if (meta.kind === 'search') return `${meta.summary.replace(/^已在/u, '正在')}…`
      return item.name ? `正在执行 ${item.name}…` : '正在执行工具…'
    }
  }
  return '正在处理…'
}
