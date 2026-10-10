import assert from 'node:assert/strict'
import test from 'node:test'
import { parsePluginManifest } from '../src/manifest'
import { PluginScope } from '../src/scope'

test('插件声明拒绝未知 SDK 和越界入口', () => {
  assert.throws(() =>
    parsePluginManifest({ name: 'clock', version: '1.0.0', piMeme: { sdkVersion: 2, ui: 'dist/ui.js' } }),
  )
  assert.throws(() =>
    parsePluginManifest({ name: 'clock', version: '1.0.0', piMeme: { sdkVersion: 1, ui: '../ui.js' } }),
  )
  assert.equal(
    parsePluginManifest({ name: '@acme/clock', version: '1.0.0', piMeme: { sdkVersion: 1, agent: 'dist/agent.js' } })
      .name,
    '@acme/clock',
  )
})

test('作用域逆序释放全部资源，失败也继续，重复释放不重复执行', async () => {
  const scope = new PluginScope()
  const order: number[] = []
  scope.own(() => {
    order.push(1)
  })
  scope.own(() => {
    order.push(2)
    throw new Error('失败')
  })
  scope.own(() => {
    order.push(3)
  })
  await assert.rejects(scope.dispose(), AggregateError)
  assert.deepEqual(order, [3, 2, 1])
  await assert.rejects(scope.dispose(), AggregateError)
  assert.deepEqual(order, [3, 2, 1])
})
