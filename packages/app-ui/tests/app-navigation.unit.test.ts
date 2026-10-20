import assert from 'node:assert/strict'
import { test } from 'vitest'
import { appNavigationReducer, initialAppNavigation } from '../src/layout/use-app-navigation'

test('页面历史去重、后退前进和 replace 不扩大历史', () => {
  const first = appNavigationReducer(initialAppNavigation, { type: 'open', route: { kind: 'projects' } })
  assert.equal(appNavigationReducer(first, { type: 'open', route: { kind: 'projects' } }), first)
  const settings = appNavigationReducer(first, { type: 'open', route: { kind: 'settings', section: 'plugins' } })
  const back = appNavigationReducer(settings, { type: 'back' })
  assert.deepEqual(back.route, { kind: 'projects' })
  assert.deepEqual(appNavigationReducer(back, { type: 'forward' }).route, settings.route)
  const next = appNavigationReducer(back, { type: 'open', route: { kind: 'customization' } })
  assert.equal(next.future.length, 0)
  assert.equal(appNavigationReducer(next, { type: 'replace', route: { kind: 'chat' } }).past.length, next.past.length)
})

test('无效插件页面从当前页和历史一起清理，不更改会话选择', () => {
  const plugin = {
    kind: 'plugin' as const,
    pluginId: 'example',
    pageId: 'example:page',
    target: { hostId: 'one' },
    params: null,
  }
  const state = appNavigationReducer(initialAppNavigation, { type: 'open', route: plugin })
  const next = appNavigationReducer(state, { type: 'prune', valid: (route) => route.kind !== 'plugin' })
  assert.deepEqual(next.route, { kind: 'chat' })
  assert.ok(next.past.every((route) => route.kind !== 'plugin'))
})
