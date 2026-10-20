import assert from 'node:assert/strict'
import { test } from 'vitest'
import { assertPageParams, createPluginUiExtensions } from '../src/plugins/plugin-ui-extensions'

function extensions() {
  const requests: unknown[] = []
  const extension = createPluginUiExtensions({
    pluginId: 'example',
    generation: 2,
    getTarget: () => ({ hostId: 'host' }),
    onChanged: () => {},
    onBack: () => {},
    onPageRequest: (request) => requests.push(request),
  })
  return { extension, requests }
}

test('一个插件只有一个入口，菜单引用在激活结束后验证', () => {
  const { extension } = extensions()
  extension.navigation.register({
    title: '检查',
    defaultPageId: 'example:overview',
    groups: [{ id: 'main', items: [{ id: 'overview', pageId: 'example:overview' }] }],
  })
  assert.throws(() => extension.validate(), /未注册页面/)
  extension.pages.register({ id: 'example:overview', title: '概览', scope: 'app', render: () => null })
  extension.validate()
  assert.throws(
    () => extension.navigation.register({ title: '第二入口', defaultPageId: 'example:overview', groups: [] }),
    /一个活动栏/,
  )
  assert.equal(extension.getNavigation()[0].generation, 2)
  extension.dispose()
  assert.equal(extension.getPages().length, 0)
})

test('页面打开捕获目标且拒绝跨 Host、缺少scope和退役上下文', async () => {
  const { extension, requests } = extensions()
  extension.pages.register({ id: 'example:app', title: '概览', scope: 'app', render: () => null })
  extension.pages.register({ id: 'example:session', title: '会话', scope: 'session', render: () => null })
  const target = { hostId: 'host', session: { hostId: 'host', sessionId: 'first' } }
  await extension.navigation.openPage('example:session', { target })
  target.session.sessionId = 'changed'
  assert.equal((requests[0] as { target: typeof target }).target.session.sessionId, 'first')
  await assert.rejects(extension.navigation.openPage('example:session'), /缺少/)
  await assert.rejects(extension.navigation.openPage('example:app', { target: { hostId: 'other' } }), /其他 Host/)
  await assert.rejects(
    extension.navigation.openPage('example:app', {
      target: { hostId: 'host', session: { hostId: 'other', sessionId: 'session' } },
    }),
    /其他 Host/,
  )
  await assert.rejects(
    extension.navigation.openPage('example:app', {
      target: { hostId: 'host', project: { hostId: 'host', projectId: '' } },
    }),
    /无效目标/,
  )
  extension.dispose()
  await assert.rejects(extension.navigation.openPage('example:app'), /plugin-retired/)
})

test('页面参数只接受真正 JSON 值，拒绝静默丢失字段及UTF8超限', () => {
  const cycle: Record<string, unknown> = {}
  cycle.self = cycle
  const sparse: unknown[] = []
  sparse.length = 2
  for (const value of [
    undefined,
    () => {},
    new Date(),
    { bad: undefined },
    { bad: () => {} },
    NaN,
    Infinity,
    cycle,
    sparse,
  ])
    assert.throws(() => assertPageParams(value), /JSON/)
  assert.throws(() => assertPageParams('中'.repeat(6000)), /16 KiB/)
  assertPageParams({ count: 2, items: [null, '有效', true] })
})
