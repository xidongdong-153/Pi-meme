import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ResourceClient } from '@pi-meme/client/resource-client'
import type { PluginClient } from '@pi-meme/client/plugin-client'
import type { UiPluginDescriptor } from '@pi-meme/plugin-sdk/ui'
import { skillMarker } from '@pi-meme/contracts/skills'
import { SettingsPage } from '../src/settings-page'
import { SkillPage } from '../src/skill-page'
import { PluginPage, PluginCapabilities } from '../src/plugin-page'
import { appendSkillInvocation } from '../src/invoke-skill'

const plugin: UiPluginDescriptor = {
  id: 'example:app',
  version: '2.0.0',
  generation: 3,
  enabled: true,
  status: 'active',
  description: '示例 App 插件',
  capabilities: { server: true, agent: true, ui: true, resources: true },
}

test('Agent 导航以模型开头，随后是技能、插件、MCP，移除资源入口与页面内切换按钮', () => {
  const html = renderToStaticMarkup(
    createElement(SettingsPage, {
      dirty: false,
      saving: false,
      onDiscard: () => {},
      onDismiss: () => {},
      renderContent: () => null,
    }),
  )
  const agent = html.slice(html.indexOf('>Agent<'), html.indexOf('>系统<'))
  const labels = [...agent.matchAll(/<span class="truncate">([^<]+)<\/span>/g)].map((match) => match[1])
  assert.deepEqual(labels, ['模型', '技能', '插件', 'MCP'])
  assert.doesNotMatch(html, />资源<|data-section="extensions"/)
})

test('技能页按个人和系统分类，并提供导入，不混入插件、MCP或模型', () => {
  const html = renderToStaticMarkup(
    createElement(SkillPage, {
      client: {} as ResourceClient,
      commands: [],
      onChanged: async () => {},
      onUse: () => {},
    }),
  )
  assert.match(html, /aria-label="技能管理"/)
  assert.match(html, /aria-label="技能类别"/)
  assert.match(html, /个人/)
  assert.match(html, /系统/)
  assert.match(html, /导入技能/)
  assert.match(html, /添加技能/)
  assert.match(html, /accept="\.md,\.zip"/)
  assert.doesNotMatch(html, /资源类型|安装插件包|应用插件|>MCP<|>模型<|\.pim/)
})

test('设置唤起系统技能时在草稿末尾插入技能标记，创建插件还带上提示语', () => {
  assert.equal(appendSkillInvocation(''), `${skillMarker} `)
  assert.equal(appendSkillInvocation('已有草稿'), `已有草稿 ${skillMarker} `)
  assert.equal(appendSkillInvocation('已有草稿 '), `已有草稿 ${skillMarker} `)
  assert.equal(appendSkillInvocation('', '帮我创建一个插件'), `${skillMarker} 帮我创建一个插件`)
})

test('插件页只列出App插件并提供pim安装，不显示技能编辑策略或混合类型筛选', () => {
  const html = renderToStaticMarkup(
    createElement(PluginPage, { client: {} as PluginClient, plugins: [plugin], errors: {}, onChanged: async () => {} }),
  )
  assert.match(html, /aria-label="插件管理"/)
  assert.match(html, /aria-label="App 插件列表"/)
  assert.match(html, /查看插件：example:app/)
  assert.match(html, /accept="\.pim"/)
  assert.match(html, /aria-label="插件类别"/)
  assert.match(html, /aria-label="添加插件"/)
  assert.match(html, /role="switch"[^>]*aria-label="启用插件：example:app"/)
  assert.match(html, /个人/)
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
  assert.match(html, /没有个人插件/)
})
