import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { HostApi } from '@pi-meme/contracts/app-host'
import type { UiContribution, UiContributionProps } from '@pi-meme/plugin-sdk/ui'
import { PluginMessage, PluginMessageProvider } from '@pi-meme/ui/components/plugin-message'
import { matchesContribution, PluginSlot } from '../src/plugins/plugin-slot'
import { UiPluginRegistry } from '../src/plugins/plugin-registry'
import { matchesMessageAction } from '../src/plugins/plugin-message-actions'
import type { RegisteredMessageAction } from '@pi-meme/plugin-sdk/message-actions'
import type { UiMessageActionSubject } from '@pi-meme/contracts/plugin-ui-data'
import { emptyPluginGrant } from '@pi-meme/plugin-sdk/permissions'

const props: UiContributionProps = {
  host: {} as HostApi,
  target: { hostId: 'host' },
  snapshot: null,
  ownerId: 'example',
  generation: 3,
  ...{ policyHash: 'fixture-policy' },
}

test('工具和消息必须同时匹配来源、代次和具体名称，未知来源不猜测', () => {
  const tool: UiContribution = {
    id: 'example:tool',
    slot: 'tool-card',
    generation: 3,
    ...{ policyHash: 'fixture-policy' },
    match: { ownerId: 'example', toolName: 'review' },
    render: () => null,
  }
  assert.equal(matchesContribution(tool, { ...props, toolName: 'review' }), true)
  assert.equal(matchesContribution(tool, { ...props, ownerId: undefined, toolName: 'review' }), false)
  assert.equal(matchesContribution(tool, { ...props, generation: 2, toolName: 'review' }), false)
  assert.equal(matchesContribution(tool, { ...props, toolName: 'other' }), false)
  assert.equal(matchesContribution(tool, { ...props, policyHash: undefined, toolName: 'review' }), false)
  assert.equal(matchesContribution(tool, { ...props, policyHash: 'other-code', toolName: 'review' }), false)
  const message: UiContribution = { ...tool, slot: 'message', match: { ownerId: 'example', customType: 'review' } }
  assert.equal(matchesContribution(message, { ...props, customType: 'review' }), true)
  assert.equal(matchesContribution(message, { ...props, customType: 'other' }), false)
})

test('没有已加载消息贡献时仍展示可读文本，防止历史消息随插件卸载消失', () => {
  const registry = new UiPluginRegistry(props.host)
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

test('类型化消息动作显式区分自身和跨消息，不授予正文渲染权', () => {
  const action: RegisteredMessageAction = {
    id: 'example:actions',
    pluginId: 'example',
    title: '保存',
    generation: 3,
    match: { source: 'self', roles: ['custom'], customType: 'review' },
    execute: () => {},
  }
  const subject: UiMessageActionSubject = {
    role: 'custom',
    refs: [],
    displayedText: '检查',
    state: 'complete',
    revision: 'one',
    source: { ownerId: 'example', generation: 3 },
    customType: 'review',
  }
  assert.equal(matchesMessageAction(action, subject), true)
  assert.equal(matchesMessageAction(action, { ...subject, source: { ownerId: 'other', generation: 3 } }), false)
  assert.equal(
    matchesMessageAction({ ...action, match: { ...action.match, source: 'any' } }, { ...subject, source: undefined }),
    true,
  )
})

test('历史同编号来源缺少或不匹配代码hash时不使用新消息renderer', async () => {
  const registry = new UiPluginRegistry(props.host, async () => ({
    activate(context) {
      context.contributions.register({
        id: 'example:new-schema',
        slot: 'message',
        policyHash: 'plugin-cannot-forge-this',
        match: { customType: 'review' },
        render: () => '新版schema',
      })
    },
  }))
  await registry.synchronize([
    {
      id: 'example',
      version: '2.0.0',
      generation: 3,
      enabled: true,
      status: 'active',
      ui: '/new.js',
      policyHash: 'new-policy',
      grant: { ...emptyPluginGrant('new-policy'), trusted: { ui: true, server: false, agent: false } },
    },
  ])
  try {
    const contribution = registry.getSnapshot()[0]!
    assert.equal(contribution.policyHash, 'new-policy')
    for (const policyHash of [undefined, 'old-policy']) {
      const legacy = {
        ...props,
        policyHash,
        customType: 'review',
        message: {
          id: 'old-entry',
          role: 'custom' as const,
          revision: 'old',
          state: 'complete' as const,
          text: '旧消息正文',
          images: [],
          data: { schema: 'old' },
        },
      }
      assert.equal(matchesContribution(contribution, legacy), false)
      assert.equal(
        renderToStaticMarkup(
          createElement(PluginSlot, { registry, slot: 'message', props: legacy, fallback: '旧消息正文' }),
        ),
        '旧消息正文',
      )
    }
    const current = { ...props, policyHash: 'new-policy', customType: 'review' }
    assert.equal(matchesContribution(contribution, current), true)
  } finally {
    await registry.dispose()
  }
})
