import type { JsonValue } from './rpc'

/** SDK 4 的外部 UI 仅包含数据，由宿主控件渲染，不执行包内脚本或 HTML。 */
export type DeclarativeUiBlock =
  { kind: 'text'; text: string } | { kind: 'action'; title: string; operation: string; input?: JsonValue }
export type DeclarativeUiSurface = {
  id: string
  title: string
  scope: 'app' | 'project' | 'session'
  blocks: DeclarativeUiBlock[]
}
export type DeclarativePluginUi = {
  version: 1
  pages?: DeclarativeUiSurface[]
  panels?: DeclarativeUiSurface[]
}

export function parseDeclarativePluginUi(value: unknown): DeclarativePluginUi {
  const object = (item: unknown): item is Record<string, unknown> =>
    Boolean(item && typeof item === 'object' && !Array.isArray(item))
  const text = (item: unknown, max: number): item is string => typeof item === 'string' && item.length <= max
  if (
    !object(value) ||
    value.version !== 1 ||
    Object.keys(value).some((key) => !['version', 'pages', 'panels'].includes(key))
  )
    throw new Error('invalid-ui: UI 必须是 version: 1 的声明式页面或面板')
  const ids = new Set<string>()
  let count = 0
  for (const name of ['pages', 'panels'] as const) {
    const surfaces = value[name]
    if (surfaces === undefined) continue
    if (!Array.isArray(surfaces) || surfaces.length > 32) throw new Error('invalid-ui: 每类 UI 最多 32 个入口')
    for (const surface of surfaces) {
      if (
        !object(surface) ||
        Object.keys(surface).some((key) => !['id', 'title', 'scope', 'blocks'].includes(key)) ||
        !text(surface.id, 80) ||
        !/^[a-zA-Z][\w.-]*$/.test(surface.id) ||
        ids.has(surface.id) ||
        !text(surface.title, 160) ||
        !surface.title.trim() ||
        !['app', 'project', 'session'].includes(String(surface.scope)) ||
        !Array.isArray(surface.blocks) ||
        surface.blocks.length > 128
      )
        throw new Error('invalid-ui: 页面标识、标题、范围或内容无效')
      ids.add(surface.id)
      for (const block of surface.blocks) {
        count++
        if (!object(block)) throw new Error('invalid-ui: 内容必须是对象')
        if (block.kind === 'text') {
          if (!text(block.text, 16000) || Object.keys(block).some((key) => !['kind', 'text'].includes(key)))
            throw new Error('invalid-ui: 文本内容无效')
        } else if (block.kind === 'action') {
          if (
            !text(block.title, 160) ||
            !block.title.trim() ||
            !text(block.operation, 80) ||
            !/^[a-zA-Z][\w-]*$/.test(block.operation) ||
            Object.keys(block).some((key) => !['kind', 'title', 'operation', 'input'].includes(key))
          )
            throw new Error('invalid-ui: 操作名称或参数无效')
        } else throw new Error('invalid-ui: 只支持 text 与 action 控件')
      }
    }
  }
  if (!ids.size || count > 512 || JSON.stringify(value).length > 128 * 1024)
    throw new Error('invalid-ui: UI 为空或超过大小限制')
  return structuredClone(value) as DeclarativePluginUi
}
