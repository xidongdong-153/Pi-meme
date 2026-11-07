import { createElement } from 'react'
import { parseDeclarativePluginUi } from '@pi-meme/plugin-sdk/declarative-ui'
import type { UiPluginModule } from '@pi-meme/plugin-sdk/ui'
import { DeclarativePluginIcon, DeclarativePluginSurface } from './declarative-plugin-ui'

/** SDK 4 UI 只读取有限声明式 JSON；绝不 import 外部插件 JavaScript。 */
export async function loadPluginUI(url: string): Promise<UiPluginModule> {
  const target = new URL(url, window.location.href)
  if (target.origin !== window.location.origin || !target.pathname.endsWith('.json'))
    throw new Error('unsupported-ui: 插件需升级为 SDK 4 声明式界面')
  const response = await fetch(target, {
    credentials: 'same-origin',
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error(`插件界面读取失败（${response.status}）`)
  const reader = response.body?.getReader()
  if (!reader) throw new Error('invalid-ui: 界面没有内容')
  let size = 0
  const chunks: Uint8Array[] = []
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 128 * 1024) throw new Error('invalid-ui: 界面超过 128 KiB')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  const ui = parseDeclarativePluginUi(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
  return {
    activate(context) {
      const dispose: Array<() => void> = []
      for (const surface of ui.panels ?? [])
        dispose.push(
          context.panels.register({
            id: `${context.pluginId}:${surface.id}`,
            title: surface.title,
            scope: surface.scope,
            icon: createElement(DeclarativePluginIcon),
            location: 'right',
            render: ({ target }) =>
              createElement(DeclarativePluginSurface, { surface, server: context.server, target }),
          }),
        )
      for (const surface of ui.pages ?? [])
        dispose.push(
          context.pages.register({
            id: `${context.pluginId}:${surface.id}`,
            title: surface.title,
            scope: surface.scope,
            render: ({ target, signal }) =>
              createElement(DeclarativePluginSurface, { surface, server: context.server, target, signal }),
          }),
        )
      if (ui.pages?.length)
        dispose.push(
          context.navigation.register({
            title: ui.pages[0].title,
            icon: createElement(DeclarativePluginIcon),
            defaultPageId: `${context.pluginId}:${ui.pages[0].id}`,
            groups: [
              {
                id: 'pages',
                items: ui.pages.map((page) => ({
                  id: page.id,
                  pageId: `${context.pluginId}:${page.id}`,
                  title: page.title,
                })),
              },
            ],
          }),
        )
      return () => {
        for (const release of dispose.reverse()) release()
      }
    },
  }
}
