import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { DesktopBridge } from '@pi-meme/contracts/desktop'
import type { UiContribution, UiContributionProps } from '@pi-meme/plugin-sdk/ui'
import { PluginMessage, PluginMessageProvider } from '@pi-meme/ui/components/plugin-message'
import { matchesContribution, PluginSlot } from '../src/plugin-slot'
import { UiPluginRegistry } from '../src/plugin-registry'

const props: UiContributionProps = { bridge: {} as DesktopBridge, ownerId: 'example', generation: 3 }

test('工具和消息必须同时匹配来源、代次和具体名称，未知来源不猜测', () => {
  const tool: UiContribution = {
    id: 'example:tool',
    slot: 'tool-card',
    generation: 3,
    match: { ownerId: 'example', toolName: 'review' },
    render: () => null,
  }
  assert.equal(matchesContribution(tool, { ...props, toolName: 'review' }), true)
  assert.equal(matchesContribution(tool, { ...props, ownerId: undefined, toolName: 'review' }), false)
  assert.equal(matchesContribution(tool, { ...props, generation: 2, toolName: 'review' }), false)
  assert.equal(matchesContribution(tool, { ...props, toolName: 'other' }), false)
  const message: UiContribution = { ...tool, slot: 'message', match: { ownerId: 'example', customType: 'review' } }
  assert.equal(matchesContribution(message, { ...props, customType: 'review' }), true)
  assert.equal(matchesContribution(message, { ...props, customType: 'other' }), false)
})

test('没有已加载消息贡献时仍展示可读文本，防止历史消息随插件卸载消失', () => {
  const registry = new UiPluginRegistry(props.bridge)
  const message = createElement(PluginMessage, {
    message: { text: '代码检查结果' },
    ownerId: 'example',
    generation: 3,
    customType: 'review',
    fallback: '代码检查结果',
  })
  assert.equal(renderToStaticMarkup(message), '代码检查结果')
  assert.equal(
    renderToStaticMarkup(
      createElement(PluginMessageProvider, {
        children: message,
        render: (_message, source, fallback) =>
          createElement(PluginSlot, { registry, slot: 'message', props: { ...props, ...source }, fallback }),
      }),
    ),
    '代码检查结果',
  )
})
