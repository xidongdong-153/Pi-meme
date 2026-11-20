import type { ReadErrorCode } from './system-read'
import type { SystemClientRequest, SystemOperation } from './system-tools'

const text = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength })
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
    properties: { app, snapshot_id: { type: 'string' }, tree: { type: 'object' } },
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
    '读取指定应用窗口的控件和引用，窗口歧义时先列出窗口',
    '[app,windowId?]',
    false,
    [app, windowId],
    1,
  ),
  operation('screenshot', '读取已授权应用单个窗口的 PNG 图片', '[app,windowId]', false, [app, windowId]),
  operation('launch', '打开指定的已安装应用', '[app]', true, [app]),
  operation('click', '点击该应用本轮快照中的控件，完成后再读取确认', '[app,ref]', true, [app, ref]),
  operation('setValue', '填写该应用本轮快照中的可编辑控件', '[app,ref,text]', true, [
    app,
    ref,
    { type: 'string', maxLength: 16000 },
  ]),
  operation('press', '向指定应用的窗口发送组合键，如 return 或 cmd+s', '[app,windowId,key]', true, [
    app,
    windowId,
    text(80),
  ]),
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
export type ComputerReply = { ok: true; result: unknown } | { ok: false; code: ReadErrorCode; message: string }
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
