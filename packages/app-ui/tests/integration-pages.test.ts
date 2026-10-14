import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ResourceClient } from '@pi-meme/client/resource-client'
import type { PluginClient } from '@pi-meme/client/plugin-client'
import type { UiPluginDescriptor } from '@pi-meme/plugin-sdk/ui'
import { SettingsPage } from '../src/settings-page'
import { SkillPage } from '../src/skill-page'
import { PluginPage, PluginCapabilities } from '../src/plugin-page'

const plugin: UiPluginDescriptor = {
  id: 'example:app',
  version: '2.0.0',
  generation: 3,
  enabled: true,
  status: 'active',
  description: '示例 App 插件',
  capabilities: { server: true, agent: true, ui: true, resources: true },
}

test('集成导航只有技能、插件、MCP，移除资源入口与页面内切换按钮', () => {
  const html = renderToStaticMarkup(
    createElement(SettingsPage, {
      dirty: false,
      saving: false,
      onDiscard: () => {},
      onDismiss: () => {},
      renderContent: () => null,
    }),
  )
  const integration = html.slice(html.indexOf('>集成<'), html.indexOf('>系统<'))
  const labels = [...integration.matchAll(/<span class="truncate">([^<]+)<\/span>/g)].map((match) => match[1])
  assert.deepEqual(labels, ['技能', '插件', 'MCP'])
  assert.doesNotMatch(html, />资源<|data-section="extensions"/)
})

test('技能页提供技能导入与创建，不显示插件、MCP、模型或资源类型Tab', () => {
  const html = renderToStaticMarkup(
    createElement(SkillPage, {
      client: {} as ResourceClient,
      commands: [],
      onChanged: async () => {},
      onUse: () => {},
    }),
  )
  assert.match(html, /aria-label="技能管理"/)
  assert.match(html, /导入技能/)
  assert.match(html, /添加技能/)
  assert.match(html, /accept="\.md,\.zip"/)
  assert.doesNotMatch(html, /资源类型|安装插件包|应用插件|>MCP<|>模型<|role="tab"|\.pim/)
})

test('插件页只列出App插件并提供pim安装，不显示技能编辑策略或混合类型筛选', () => {
  const html = renderToStaticMarkup(
    createElement(PluginPage, { client: {} as PluginClient, plugins: [plugin], errors: {}, onChanged: async () => {} }),
  )
  assert.match(html, /aria-label="插件管理"/)
  assert.match(html, /aria-label="App 插件列表"/)
  assert.match(html, /查看插件：example:app/)
  assert.match(html, /安装插件包/)
  assert.match(html, /accept="\.pim"/)
  assert.match(html, /aria-label="插件来源"/)
  assert.match(html, /role="switch"[^>]*aria-label="启用插件：example:app"/)
  assert.match(html, /已安装/)
  assert.match(html, /系统/)
  assert.doesNotMatch(html, /资源类型|新建技能|编辑 SKILL\.md|技能策略范围|>MCP<|lg:grid-cols-2/)
})

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
  assert.match(html, /没有已安装的 App 插件/)
})
