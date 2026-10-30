import assert from 'node:assert/strict'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'vitest'
import { features, suites } from './catalog'
import { requiredBuilds, selectTests } from './selection'

test('无范围、错误功能、错误层次和未登记文件不能误跑全部测试', () => {
  for (const args of [[], ['--feature', 'missing'], ['--all', '--layer', 'missing'], ['--file', 'missing.test.ts']])
    assert.throws(() => selectTests(args))
  assert.throws(() => selectTests(['--all', '--feature', 'sessions']))
  assert.throws(() => selectTests(['--feature', 'sessions', '--file', suites[0].file]))
  assert.throws(() => selectTests(['--all', '--name', '会话']), /--file/)
})

test('功能选择跨包且只加载所选文件，默认不构建或启动应用', () => {
  const selected = selectTests(['--feature', 'plan'])
  assert.ok(selected.suites.some((suite) => suite.file.startsWith('packages/contracts/')))
  assert.ok(selected.suites.some((suite) => suite.file.startsWith('packages/pi-runtime/')))
  assert.ok(selected.suites.every((suite) => suite.features.includes('plan')))
  assert.ok(selected.suites.every((suite) => ['unit', 'component', 'integration'].includes(suite.layer)))
  assert.deepEqual(requiredBuilds(selected.suites), [])
})

test('多个功能取并集并去重，层次过滤不扩大范围', () => {
  const selected = selectTests([
    '--feature',
    'plan',
    '--feature',
    'chat',
    '--feature',
    'plan',
    '--layer',
    'unit,component',
  ])
  assert.equal(new Set(selected.suites.map((suite) => suite.file)).size, selected.suites.length)
  assert.ok(selected.suites.every((suite) => ['unit', 'component'].includes(suite.layer)))
  assert.ok(selected.suites.every((suite) => suite.features.includes('plan') || suite.features.includes('chat')))
})

test('主线只选择固定源码用例，不包含专项全集、E2E 或构建，和业务选择合并时去重', () => {
  const core = selectTests(['--feature', 'core'])
  assert.deepEqual(
    core.suites.map((suite) => suite.file).sort(),
    [
      'packages/chat/tests/chat.unit.test.ts',
      'packages/chat/tests/composer-submit.component.test.tsx',
      'packages/client/tests/client-auth.unit.test.ts',
      'packages/client/tests/client-sessions.unit.test.ts',
      'packages/host/tests/app-control-core.integration.test.ts',
      'packages/host/tests/host-transport.integration.test.ts',
      'packages/pi-runtime/tests/pause-queue-core.integration.test.ts',
      'packages/pi-runtime/tests/sdk-access-sandbox.integration.test.ts',
    ].sort(),
  )
  assert.deepEqual(requiredBuilds(core.suites), [])
  const combined = selectTests(['--feature', 'core', '--feature', 'chat'])
  const chat = selectTests(['--feature', 'chat'])
  assert.deepEqual(
    combined.suites.map((suite) => suite.file).sort(),
    [...new Set([...core.suites, ...chat.suites].map((suite) => suite.file))].sort(),
  )
})

test('单文件和用例名称保留精确范围，清单模式不执行测试', () => {
  const file = 'packages/contracts/tests/plan-message.unit.test.ts'
  const selected = selectTests(['--file', path.resolve(file), '--name', '中文', '--list'])
  assert.deepEqual(
    selected.suites.map((suite) => suite.file),
    [file],
  )
  assert.equal(selected.name, '中文')
  assert.equal(selected.list, true)
  assert.equal(selectTests(['--list']).help, true)
  assert.throws(() => selectTests(['--file', file, '--name', '[']))
})

test('完整测试按当前平台列出，显式选择不支持的产物必须报错', () => {
  const linux = selectTests(['--all'], 'linux')
  assert.ok(linux.suites.some((suite) => suite.target === 'server'))
  assert.ok(!linux.suites.some((suite) => suite.platforms?.includes('darwin')))
  assert.throws(() => selectTests(['--all', '--layer', 'artifact', '--target', 'desktop'], 'linux'), /不支持/)
  const mac = selectTests(['--all'], 'darwin')
  assert.equal(requiredBuilds(mac.suites).filter((build) => build === 'package').length, 1)
  assert.throws(() => selectTests(['--all', '--coverage']), /--layer/)
})

test('显式提供已构建产物时不重建它们，但不影响 Web E2E 的构建', () => {
  const artifacts = selectTests(['--all', '--layer', 'artifact'], 'darwin')
  assert.deepEqual(requiredBuilds(artifacts.suites, { serverBundle: true, desktopApp: true }), [])
  assert.deepEqual(requiredBuilds(artifacts.suites, { serverBundle: true }), ['package'])
  assert.deepEqual(requiredBuilds(artifacts.suites, { desktopApp: true }), ['build:server'])
  const e2e = selectTests(['--all', '--layer', 'e2e'], 'darwin')
  assert.ok(e2e.suites.every((suite) => suite.target === 'web'))
  assert.deepEqual(requiredBuilds(e2e.suites, { serverBundle: true, desktopApp: true }), ['build:web'])
  assert.throws(() => selectTests(['--all', '--layer', 'e2e', '--target', 'desktop'], 'darwin'), /没有/)
})

test('所有测试都必须登记功能与层次，清单不能重复或引用不存在的文件', async () => {
  const files: string[] = []
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`
      if (entry.isDirectory()) await walk(file)
      else if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)) files.push(file)
    }
  }
  for (const area of ['apps', 'packages', 'plugins'])
    for (const owner of await readdir(area, { withFileTypes: true })) {
      const directory = `${area}/${owner.name}/tests`
      if (owner.isDirectory() && (await stat(directory).catch(() => undefined))?.isDirectory()) await walk(directory)
    }
  await walk('tests')
  assert.equal(new Set(suites.map((suite) => suite.file)).size, suites.length)
  assert.deepEqual([...files].sort(), suites.map((suite) => suite.file).sort())
  for (const suite of suites) {
    assert.ok(suite.features.length > 0, `${suite.file} 缺少功能`)
    assert.ok(
      suite.features.every((feature) => feature in features),
      `${suite.file} 使用未知功能`,
    )
    assert.ok(suite.file.includes(`.${suite.layer}.`), `${suite.file} 层次与文件名不一致`)
  }
})
