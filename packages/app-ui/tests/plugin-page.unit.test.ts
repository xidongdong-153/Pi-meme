import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PluginClient } from '@pi-meme/client/plugin-client'
import { PluginPage, PluginCapabilities } from '../src/plugin-page'
import { plugin } from './integration-pages-fixture'

test('插件能力明确说明后台服务、逐会话Agent、面板、包内资源的行为', () => {
  const html = renderToStaticMarkup(createElement(PluginCapabilities, { plugin }))
  assert.match(html, /后台服务/)
  assert.match(html, /逐会话选择/)
  assert.match(html, /安装或启用插件不会自动加入当前聊天/)
  assert.match(html, /面板/)
  assert.match(html, /随插件一起更新和卸载/)
  const agentOnly = renderToStaticMarkup(
    createElement(PluginCapabilities, {
      plugin: { ...plugin, capabilities: { server: false, agent: true, ui: false, resources: false } },
    }),
  )
  assert.match(agentOnly, /Agent 工具与消息/)
  assert.doesNotMatch(agentOnly, /Host 服务|包内资源|界面：/)
})

test('旧 Host 的文件和终端安装条目不会出现在可停用的普通插件列表中', () => {
  const html = renderToStaticMarkup(
    createElement(PluginPage, {
      client: {} as PluginClient,
      plugins: ['@pi-meme/file-directory', '@pi-meme/terminal'].map((id) => ({ ...plugin, id })),
      errors: {},
      onChanged: async () => {},
    }),
  )
  assert.doesNotMatch(html, /启用插件：@pi-meme\/(?:file-directory|terminal)/)
  assert.match(html, /没有个人插件/)
})
