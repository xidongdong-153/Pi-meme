import type { ReadErrorCode, SystemReadErrorDetails } from './system-read'
import type { SystemClientRequest, SystemOperation } from './system-tools'

export const computerSnapshotSurfaces = ['window', 'menubar', 'menu', 'sheet'] as const
export type ComputerSnapshotSurface = (typeof computerSnapshotSurfaces)[number]
export type ComputerSnapshotOptions = { surface: ComputerSnapshotSurface; windowId?: string }
export const computerWindowActions = ['close', 'minimize', 'fullscreen', 'zoom'] as const
export type ComputerWindowAction = (typeof computerWindowActions)[number]

const text = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength })
function options(properties: Record<string, unknown>, required: string[] = []) {
  return { type: 'object', properties, required, additionalProperties: false }
}
const app = text(180)
const windowId = text(80)
const ref = text(100)
const outputSchemas: Record<string, Record<string, unknown>> = {
  windows: {
    type: 'array',
    items: { type: 'object', required: ['id', 'title'], properties: { id: windowId, title: { type: 'string' } } },
  },
  snapshot: {
    type: 'object',
    required: ['app', 'snapshot_id', 'tree'],
    properties: {
      app,
      snapshot_id: { type: 'string' },
      surface: { enum: computerSnapshotSurfaces },
      tree: { type: 'object' },
    },
  },
  screenshot: {
    type: 'object',
    required: ['type', 'mimeType', 'data'],
    properties: { type: { enum: ['image'] }, mimeType: { enum: ['image/png'] }, data: { type: 'string' } },
  },
}
function operation(
  name: string,
  description: string,
  parameters: string,
  write: boolean,
  fields: object[],
  minItems = fields.length,
): SystemOperation {
  return {
    name: `computer.${name}`,
    description,
    parameters,
    write,
    scope: 'client',
    domain: 'computer',
    outputSchema: outputSchemas[name] ?? { type: 'object' },
    inputSchema: { type: 'array', prefixItems: fields, minItems, maxItems: fields.length },
  }
}

export const computerOperations = [
  operation('windows', '列出指定本机 Mac 应用的窗口，首次使用由用户授权。app 为应用名称或 bundle ID', '[app]', false, [
    app,
  ]),
  operation(
    'snapshot',
    '读取窗口控件或应用原生菜单的引用。menubar 已提供明确且支持 Click 的目标项时可直接点击。缺少可用项时再展开所属菜单并读 menu。菜单可在无普通窗口时读取',
    '[app,windowId?] 或 [app,{surface:"window"|"menubar"|"menu"|"sheet",windowId?}]',
    false,
    [app, { anyOf: [windowId, options({ surface: { enum: computerSnapshotSurfaces }, windowId }, ['surface'])] }],
    1,
  ),
  operation('screenshot', '读取已授权应用单个窗口的 PNG 图片', '[app,windowId]', false, [app, windowId]),
  operation(
    'launch',
    '打开指定的已安装应用。activate 为 true 时请求显示窗口，并等待窗口出现',
    '[app,{activate?}?]',
    true,
    [app, options({ activate: { type: 'boolean' } })],
    1,
  ),
  operation(
    'click',
    '点击当前快照中声明 Click 的控件，随后回读确认。关闭、最小化、全屏或缩放窗口须明确提供窗口及动作',
    '[app,ref,{windowId,windowAction:"close"|"minimize"|"fullscreen"|"zoom"}?]',
    true,
    [app, ref, options({ windowId, windowAction: { enum: computerWindowActions } }, ['windowId', 'windowAction'])],
    2,
  ),
  operation('setValue', '填写该应用本轮快照中的可编辑控件', '[app,ref,text]', true, [
    app,
    ref,
    { type: 'string', maxLength: 16000 },
  ]),
  operation(
    'press',
    '向指定应用的窗口发送组合键，如 cmd+, 或 cmd+comma。focus 为 true 时先激活同一窗口并验证焦点',
    '[app,windowId,key,{focus?}?]',
    true,
    [app, windowId, text(80), options({ focus: { type: 'boolean' } })],
    3,
  ),
]

export type ComputerState = {
  enabled: boolean
  accessibility: boolean
  screenRecording: string
  grants: { hostId: string; appId: string; name: string }[]
  pendingId?: string
  active?: { hostId: string; sessionId: string; app: string; operation: string; executionId: string }
}

export type ComputerPermission = 'accessibility' | 'screen'
export type ComputerReply =
  { ok: true; result: unknown } | { ok: false; code: ReadErrorCode; message: string; details?: SystemReadErrorDetails }
export type ComputerPlatform = {
  state: () => Promise<ComputerState>
  enable: (enabled: boolean) => Promise<void>
  revoke: (hostId: string, appId: string) => Promise<void>
  permission: (kind: ComputerPermission) => Promise<void>
  stop: (executionId: string) => Promise<void>
  authorize: (request: SystemClientRequest) => Promise<ComputerReply>
  execute: (request: SystemClientRequest) => Promise<ComputerReply>
  respond: (id: string, decision: 'once' | 'always' | 'deny') => Promise<void>
  release: (registrationId: string, executionId?: string) => Promise<void>
  onChange: (listener: () => void) => () => void
}

export function desktopComputer(): ComputerPlatform | undefined {
  return (globalThis as { window?: { piPlatform?: { computer?: ComputerPlatform } } }).window?.piPlatform?.computer
}
