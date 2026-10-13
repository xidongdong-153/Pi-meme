import assert from 'node:assert/strict'
import test from 'node:test'
import { parsePluginManifest } from '../src/manifest'
import { PluginScope } from '../src/scope'

test('插件声明拒绝未知 SDK 和越界入口', () => {
  assert.throws(() =>
    parsePluginManifest({ name: 'clock', version: '1.0.0', piMeme: { sdkVersion: 1, ui: 'dist/ui.js' } }),
  )
  assert.throws(() =>
    parsePluginManifest({ name: 'clock', version: '1.0.0', piMeme: { sdkVersion: 2, ui: '../ui.js' } }),
  )
  assert.equal(
    parsePluginManifest({ name: '@acme/clock', version: '1.0.0', piMeme: { sdkVersion: 2, agent: 'dist/agent.js' } })
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

test('显示信息和资源声明保留包内路径，拒绝越界、通配符和重复 Agent 入口', () => {
  const base = { name: 'resources-app', version: '1.0.0', piMeme: { sdkVersion: 2, ui: 'dist/ui/entry.js' } }
  const valid = parsePluginManifest({
    ...base,
    piMeme: {
      ...base.piMeme,
      display: { name: '代码检查', icon: 'assets/icon.svg' },
      resources: { skills: ['skills/review'], themes: ['themes/review.json'], assets: ['assets'] },
    },
  })
  assert.equal(valid.piMeme.display?.name, '代码检查')
  assert.deepEqual(valid.piMeme.resources?.skills, ['skills/review'])
  for (const resources of [
    { skills: ['../outside'] },
    { extensions: ['extensions/*.ts'] },
    { skills: ['skills/review', 'skills/review'] },
    { mcp: ['mcp.json'] },
  ]) {
    assert.throws(() => parsePluginManifest({ ...base, piMeme: { ...base.piMeme, resources } }))
  }
  assert.throws(() =>
    parsePluginManifest({ ...base, piMeme: { ...base.piMeme, display: { icon: 'https://example.com/icon.svg' } } }),
  )
  assert.throws(() =>
    parsePluginManifest({
      ...base,
      piMeme: { ...base.piMeme, agent: 'dist/agent.js', resources: { extensions: ['dist/agent.js'] } },
    }),
  )
  assert.ok(parsePluginManifest({ ...base, piMeme: { sdkVersion: 2, resources: { themes: ['themes/a.json'] } } }))
})
