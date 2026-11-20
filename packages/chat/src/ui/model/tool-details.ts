import type { ActivityItem } from './types'
import type { ComputerSnapshotSurface } from '@pi-meme/contracts/computer-use'

export type ToolKind =
  'command' | 'read' | 'write' | 'edit' | 'search' | 'image' | 'image-generation' | 'computer' | 'generic'

const commandExecutionNames = new Set([
  'bash',
  'powershell',
  'exec_command',
  'execute_command',
  'run_command',
  'run_terminal_cmd',
  'run_terminal_command',
])

export function isCommandExecution(item: ActivityItem): boolean {
  if (item.type === 'thinking' || item.type === 'narration') return false
  const name =
    (item.name ?? '')
      .toLowerCase()
      .split(/__|[.:/]/u)
      .at(-1) ?? ''
  return commandExecutionNames.has(name)
}

function isImagePath(pathStr: string): boolean {
  if (!pathStr) return false
  return /\.(?:png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(pathStr)
}

function getBasename(pathStr: string): string {
  if (!pathStr) return ''
  const normalized = pathStr.replace(/\\/g, '/')
  const parts = normalized.split('/')
  return parts[parts.length - 1] || pathStr
}

type FileChangeStats = { insertions: number; deletions: number; created?: boolean }
const fileStats = new WeakMap<object, { patch: string; stats: FileChangeStats }>()

export function fileChangeStats(result: unknown): FileChangeStats | undefined {
  if (!result || typeof result !== 'object') return
  const value = result as Record<string, unknown>
  const details =
    value.details && typeof value.details === 'object' ? (value.details as Record<string, unknown>) : value
  if (typeof details.patch !== 'string') return
  const created = typeof details.created === 'boolean' ? details.created : undefined
  const cached = fileStats.get(details)
  if (cached?.patch === details.patch && cached.stats.created === created) return cached.stats
  let insertions = 0
  let deletions = 0
  for (const line of details.patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) insertions++
    if (line.startsWith('-') && !line.startsWith('---')) deletions++
  }
  const stats = { insertions, deletions, created }
  fileStats.set(details, { patch: details.patch, stats })
  return stats
}

export function extractFilePatch(result: unknown): string | null {
  if (result && typeof result === 'object') {
    const value = result as Record<string, unknown>
    const details =
      value.details && typeof value.details === 'object' ? (value.details as Record<string, unknown>) : value
    if (typeof details.patch === 'string' && details.patch.trim()) return details.patch
  }
  return extractDiff(result)
}

export function extractDiff(result: unknown): string | null {
  if (!result) return null
  if (typeof result === 'string') {
    if (result.includes('@@') && (result.includes('\n+') || result.includes('\n-'))) {
      return result.trim()
    }
    return null
  }
  if (typeof result === 'object') {
    const rec = result as Record<string, unknown>
    if (typeof rec.diff === 'string' && rec.diff.trim()) return rec.diff.trim()
    if (typeof rec.patch === 'string' && rec.patch.trim()) return rec.patch.trim()
    if (rec.details && typeof rec.details === 'object') {
      const details = rec.details as Record<string, unknown>
      if (typeof details.diff === 'string' && details.diff.trim()) return details.diff.trim()
      if (typeof details.patch === 'string' && details.patch.trim()) return details.patch.trim()
    }
  }
  return null
}

export function extractImages(result: unknown): Array<{ data: string; mimeType: string }> {
  if (!result || typeof result !== 'object') return []
  const rec = (Array.isArray(result) ? { content: result } : result) as Record<string, unknown>
  const images: Array<{ data: string; mimeType: string }> = []
  if (Array.isArray(rec.content)) {
    for (const b of rec.content) {
      if (
        b &&
        typeof b === 'object' &&
        'type' in b &&
        b.type === 'image' &&
        typeof b.data === 'string' &&
        typeof b.mimeType === 'string'
      ) {
        images.push({ data: b.data, mimeType: b.mimeType })
      }
    }
  }
  return images
}

export function formatDetailValue(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'object') {
    const rec = (Array.isArray(value) ? { content: value } : value) as Record<string, unknown>
    if (Array.isArray(rec.content)) {
      const parts: string[] = []
      for (const b of rec.content) {
        if (typeof b === 'string') parts.push(b)
        else if (b && typeof b === 'object' && 'text' in b && typeof b.text === 'string') {
          parts.push(b.text)
        } else if (b && typeof b === 'object' && 'type' in b && b.type === 'image') {
          continue
        } else {
          parts.push(JSON.stringify(b, null, 2))
        }
      }
      return parts.join('\n')
    }
    return JSON.stringify(value, null, 2)
  }
  return String(value)
}

export type ComputerToolInfo = {
  operation: string
  action: string
  app: string
  windowId?: string
  surface?: ComputerSnapshotSurface
  ref?: string
  text?: string
  key?: string
  isWrite: boolean
}

const computerWriteActions = new Set(['launch', 'click', 'setValue', 'press'])
const computerSurfaceLabels = {
  window: '界面控件',
  menubar: '应用菜单栏',
  menu: '原生菜单',
  sheet: '窗口对话框',
} satisfies Record<ComputerSnapshotSurface, string>

export function computerSurfaceLabel(surface: ComputerSnapshotSurface | undefined) {
  return computerSurfaceLabels[surface ?? 'window']
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
}

function resultString(value: unknown) {
  return typeof value === 'string' && value ? value : undefined
}

export function parseComputerTool(item: ActivityItem): ComputerToolInfo | undefined {
  if (item.type === 'thinking' || item.type === 'narration') return
  const name = (item.name || '').toLowerCase()
  if (name !== 'system_read' && name !== 'system_write') return
  const args = item.args as Record<string, unknown> | undefined
  const operation = typeof args?.operation === 'string' ? args.operation : ''
  if (!operation.startsWith('computer.')) return
  const action = operation.slice('computer.'.length)
  const opArgs = Array.isArray(args?.args) ? args.args : []
  const app = typeof opArgs[0] === 'string' ? opArgs[0] : ''
  const second = resultString(opArgs[1])
  const third = typeof opArgs[2] === 'string' ? opArgs[2] : undefined
  const snapshotOptions = action === 'snapshot' ? objectRecord(opArgs[1]) : undefined
  const surface = resultString(snapshotOptions?.surface)
  const windowAction = action === 'click' ? objectRecord(opArgs[2]) : undefined
  return {
    operation,
    action,
    app,
    windowId:
      action === 'snapshot' || action === 'screenshot' || action === 'press'
        ? (second ?? resultString(snapshotOptions?.windowId))
        : resultString(windowAction?.windowId),
    surface:
      surface && Object.hasOwn(computerSurfaceLabels, surface) ? (surface as ComputerSnapshotSurface) : undefined,
    ref: action === 'click' || action === 'setValue' ? second : undefined,
    text: action === 'setValue' ? third : undefined,
    key: action === 'press' ? third : undefined,
    isWrite: computerWriteActions.has(action),
  }
}

export function parseComputerResult(result: unknown) {
  const rawText = formatDetailValue(result)
  let parsed: unknown = result
  if (rawText) {
    try {
      parsed = JSON.parse(rawText)
    } catch {
      parsed = rawText
    }
  }
  const record = objectRecord(parsed)
  const err = objectRecord(record?.error)
  const details = objectRecord(err?.details)
  const disposition = objectRecord(record?.disposition)
  const resolvedTarget = objectRecord(record?.resolvedTarget)
  return {
    parsed,
    rawText,
    delivery: resultString(details?.delivery ?? disposition?.delivery),
    retry: resultString(details?.retry ?? disposition?.retry),
    target: resultString(resolvedTarget?.name),
    error: err
      ? {
          code: resultString(err.code),
          message: resultString(err.message),
          nativeCode: resultString(details?.nativeCode),
          phase: resultString(details?.phase),
          recovery: resultString(details?.recovery),
        }
      : undefined,
  }
}

function computerSummary(info: ComputerToolInfo, result: unknown): string {
  const app = info.app || '应用'
  if (info.isWrite && result) {
    const { delivery, error } = parseComputerResult(result)
    if (error) return `${app} 的操作失败`
    if (delivery === 'delivered_unverified' || delivery === 'delivery_uncertain') return `${app} 的操作结果待确认`
    if (delivery === 'not_delivered') return `${app} 的操作未送达`
  }
  switch (info.action) {
    case 'windows': {
      const { parsed } = parseComputerResult(result)
      const count = Array.isArray(parsed) ? parsed.length : undefined
      return count !== undefined ? `已查看 ${app} 的 ${count} 个窗口` : `已查看 ${app} 的窗口`
    }
    case 'snapshot':
      return `已读取 ${app} 的${computerSurfaceLabel(info.surface)}`
    case 'screenshot':
      return `已截取 ${app} 的窗口`
    case 'launch':
      return objectRecord(parseComputerResult(result).parsed)?.window ? `已打开 ${app} 的窗口` : `已启动 ${app}`
    case 'click':
      return `已点击 ${app} 中的控件`
    case 'setValue':
      return `已在 ${app} 中填写内容`
    case 'press':
      return info.key ? `已向 ${app} 发送按键 ${info.key}` : `已向 ${app} 发送按键`
    default:
      return info.app ? `已操作 ${info.app}` : '已操作电脑'
  }
}

export function parseToolMeta(item: ActivityItem): {
  kind: ToolKind | 'thinking'
  summary: string
  fullPath?: string
} {
  if (item.type === 'thinking') {
    return {
      kind: 'thinking',
      summary: '思考过程',
    }
  }

  if (item.type === 'narration') {
    return {
      kind: 'generic',
      summary: item.text,
    }
  }

  const name = (item.name || '').toLowerCase()
  const args = item.args as Record<string, unknown> | undefined

  if (name === 'request_user_input') return { kind: 'generic', summary: '已向用户提问' }
  const computer = parseComputerTool(item)
  if (computer) {
    return {
      kind: 'computer',
      summary: computerSummary(computer, item.result),
    }
  }
  if (name === 'image_gen') {
    const editing = Boolean(
      (Array.isArray(args?.referenced_image_paths) && args.referenced_image_paths.length) ||
      args?.num_last_images_to_include,
    )
    const result = item.result as { details?: { artifact?: { path?: string } } } | undefined
    return {
      kind: 'image-generation',
      summary: editing ? '已编辑图片' : '已生成图片',
      fullPath: result?.details?.artifact?.path,
    }
  }

  // 1. 命令类
  if (
    isCommandExecution(item) ||
    item.command ||
    name.includes('bash') ||
    name.includes('terminal') ||
    name.includes('exec') ||
    name.includes('cmd')
  ) {
    const rawCmd =
      item.command ||
      (typeof args?.command === 'string'
        ? args.command
        : typeof args?.CommandLine === 'string'
          ? args.CommandLine
          : typeof args?.cmd === 'string'
            ? args.cmd
            : '')
    const firstLine = rawCmd.split('\n')[0]?.trim() || ''
    return {
      kind: 'command',
      summary: firstLine ? `已运行 ${firstLine}` : '运行了命令',
    }
  }

  // 2. 搜索类
  if (name.includes('search') || name.includes('grep') || name.includes('find')) {
    const query =
      typeof args?.query === 'string'
        ? args.query
        : typeof args?.pattern === 'string'
          ? args.pattern
          : typeof args?.search === 'string'
            ? args.search
            : ''
    const target =
      typeof args?.path === 'string'
        ? getBasename(args.path)
        : typeof args?.AbsolutePath === 'string'
          ? getBasename(args.AbsolutePath)
          : typeof args?.domain === 'string'
            ? args.domain
            : '代码'
    return {
      kind: 'search',
      summary: query ? `已在 ${target} 中搜索 “${query}”` : '已在代码中搜索',
    }
  }

  // 3. 图像查看
  const resultImages = extractImages(item.result)
  const isImageTool = name.includes('image') || name.includes('img') || name.includes('screenshot')
  const readPathVal =
    typeof args?.path === 'string'
      ? args.path
      : typeof args?.file === 'string'
        ? args.file
        : typeof args?.filePath === 'string'
          ? args.filePath
          : typeof args?.AbsolutePath === 'string'
            ? args.AbsolutePath
            : ''
  if (isImageTool || resultImages.length > 0 || isImagePath(readPathVal)) {
    const count = resultImages.length
    return {
      kind: 'image',
      summary: count > 0 ? `已查看 ${count} 张图像` : '查看图像',
      fullPath: readPathVal,
    }
  }

  // 4. 读取文件
  if (name.includes('read') || name.includes('view') || name.includes('cat')) {
    const filename = getBasename(readPathVal)
    return {
      kind: 'read',
      summary: filename ? `已读取 ${filename}` : '已读取文件',
      fullPath: readPathVal,
    }
  }

  // 5. 编辑文件
  if (name.includes('edit') || name.includes('patch') || name.includes('replace')) {
    const pathVal =
      typeof args?.path === 'string'
        ? args.path
        : typeof args?.file === 'string'
          ? args.file
          : typeof args?.filePath === 'string'
            ? args.filePath
            : typeof args?.TargetFile === 'string'
              ? args.TargetFile
              : ''
    const filename = getBasename(pathVal)
    return {
      kind: 'edit',
      summary: filename ? `已编辑 ${filename}` : '已编辑文件',
      fullPath: pathVal,
    }
  }

  // 5. 写入/创建文件
  if (name.includes('write') || name.includes('create')) {
    const pathVal =
      typeof args?.path === 'string'
        ? args.path
        : typeof args?.file === 'string'
          ? args.file
          : typeof args?.filePath === 'string'
            ? args.filePath
            : typeof args?.TargetFile === 'string'
              ? args.TargetFile
              : ''
    const filename = getBasename(pathVal)
    const overwritten = fileChangeStats(item.result)?.created === false
    return {
      kind: overwritten ? 'edit' : 'write',
      summary: filename ? `${overwritten ? '已编辑' : '已创建'} ${filename}` : '已写入文件',
      fullPath: pathVal,
    }
  }

  // 6. 通用工具
  return {
    kind: 'generic',
    summary: item.name ? `已执行 ${item.name}` : '执行了工具',
  }
}
