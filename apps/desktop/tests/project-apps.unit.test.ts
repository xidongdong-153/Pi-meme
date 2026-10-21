import assert from 'node:assert/strict'
import { beforeEach, test, vi } from 'vitest'
import { getProjectApps, openProjectInApp } from '../src/main/project-apps'

const mocks = vi.hoisted(() => ({ execute: vi.fn(), realpath: vi.fn(), stat: vi.fn() }))
vi.mock('node:child_process', () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: mocks.execute }),
}))
vi.mock('node:fs/promises', () => ({ realpath: mocks.realpath, stat: mocks.stat }))

const vscode = { id: 'vscode', bundleId: 'com.microsoft.VSCode', path: '/Applications/Visual Studio Code.app' }
const manager = { id: 'finder', name: '系统文件管理器' }
function output(entries: unknown) {
  return { stdout: JSON.stringify(entries), stderr: '' }
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.execute.mockResolvedValue(output([]))
  mocks.realpath.mockImplementation(async (value: string) => value)
  mocks.stat.mockResolvedValue({ isDirectory: () => true })
})

test('单次固定 JXA 查询只返回已安装应用，不向界面暴露应用路径', async () => {
  mocks.execute.mockResolvedValue(
    output([
      vscode,
      {
        id: 'webstorm',
        bundleId: 'com.jetbrains.WebStorm',
        path: '/Users/用户/Library/Application Support/JetBrains/Toolbox/apps/WebStorm.app',
      },
    ]),
  )
  assert.deepEqual(await getProjectApps(), [
    manager,
    { id: 'vscode', name: 'Visual Studio Code' },
    { id: 'webstorm', name: 'WebStorm' },
  ])
  assert.equal(mocks.execute.mock.calls.length, 1)
  const [executable, args, options] = mocks.execute.mock.calls[0]
  assert.equal(executable, '/usr/bin/osascript')
  assert.deepEqual(args.slice(0, 3), ['-l', 'JavaScript', '-e'])
  assert.match(args[3], /NSWorkspace.sharedWorkspace/)
  assert.match(args[3], /URLForApplicationWithBundleIdentifier/)
  assert.match(args[3], /bundleIdentifier/)
  assert.equal(options.timeout, 5000)
  assert.equal(options.maxBuffer, 256 * 1024)
  assert.equal(options.shell, undefined)
})

test('同产品不同 edition 按候选顺序去重，而非按查询结果顺序选择', async () => {
  mocks.execute.mockResolvedValue(
    output([
      { id: 'intellij-idea', bundleId: 'com.jetbrains.intellij.ce', path: '/Applications/IDEA CE.app' },
      { id: 'intellij-idea', bundleId: 'com.jetbrains.intellij', path: '/Applications/IDEA.app' },
      { id: 'intellij-idea', bundleId: 'com.jetbrains.intellij', path: '/Applications/IDEA.app' },
    ]),
  )
  assert.deepEqual(await getProjectApps(), [manager, { id: 'intellij-idea', name: 'IntelliJ IDEA' }])
  await openProjectInApp('intellij-idea', '/work/project')
  assert.deepEqual(mocks.execute.mock.calls[2].slice(0, 2), [
    '/usr/bin/open',
    ['-a', '/Applications/IDEA.app', '/work/project'],
  ])
})

test('忽略已失效注册、非目录和解析后不再是应用的路径，保留可用 edition', async () => {
  mocks.execute.mockResolvedValue(
    output([
      vscode,
      { id: 'cursor', bundleId: 'com.todesktop.230313mzl4w4u92', path: '/Applications/Cursor.app' },
      { id: 'zed', bundleId: 'dev.zed.Zed', path: '/Applications/Zed.app' },
      { id: 'pycharm', bundleId: 'com.jetbrains.pycharm', path: '/Applications/PyCharm.app' },
      { id: 'pycharm', bundleId: 'com.jetbrains.pycharm.ce', path: '/Applications/PyCharm CE.app' },
    ]),
  )
  mocks.realpath.mockImplementation(async (value: string) => {
    if (value === vscode.path || value.endsWith('/PyCharm.app'))
      throw Object.assign(new Error('缺失'), { code: 'ENOENT' })
    return value.endsWith('/Zed.app') ? '/Applications/not-an-app' : value
  })
  mocks.stat.mockImplementation(async (value: string) => ({ isDirectory: () => !value.endsWith('/Cursor.app') }))
  assert.deepEqual(await getProjectApps(), [manager, { id: 'pycharm', name: 'PyCharm' }])
})

test('同一实际应用路径不会重复出现在列表', async () => {
  mocks.execute.mockResolvedValue(
    output([vscode, { id: 'zed', bundleId: 'dev.zed.Zed', path: '/Applications/Zed.app' }]),
  )
  mocks.realpath.mockResolvedValue('/Applications/Shared.app')
  assert.deepEqual(await getProjectApps(), [manager, { id: 'vscode', name: 'Visual Studio Code' }])
})

test.each([
  null,
  {},
  [null],
  [{ ...vscode, id: 'unknown' }],
  [{ ...vscode, id: 'cursor' }],
  [{ ...vscode, bundleId: 'unknown.bundle' }],
  [{ ...vscode, path: 'relative.app' }],
  [{ ...vscode, path: '/Applications/tool' }],
  [{ ...vscode, path: '/Applications/bad\0.app' }],
  [{ ...vscode, path: 123 }],
])('拒绝非法系统查询结果 %#', async (value) => {
  mocks.execute.mockResolvedValue(output(value))
  await assert.rejects(getProjectApps(), /无法识别本机应用.*格式无效/)
  assert.equal(mocks.realpath.mock.calls.length, 0)
})

test('无效 JSON 和查询超时都会报错，失败后允许重试，不执行其他探测方式', async () => {
  mocks.execute
    .mockResolvedValueOnce({ stdout: '{invalid', stderr: '' })
    .mockRejectedValueOnce(Object.assign(new Error('查询超时'), { killed: true, code: 'ETIMEDOUT' }))
    .mockResolvedValueOnce(output([vscode]))
  await assert.rejects(getProjectApps(), /无法识别本机应用/)
  await assert.rejects(getProjectApps(), /无法识别本机应用.*查询超时/)
  assert.deepEqual(await getProjectApps(), [manager, { id: 'vscode', name: 'Visual Studio Code' }])
  assert.deepEqual(
    mocks.execute.mock.calls.map(([executable]) => executable),
    ['/usr/bin/osascript', '/usr/bin/osascript', '/usr/bin/osascript'],
  )
})

test('应用目录权限错误可见，不伪装成未安装', async () => {
  mocks.execute.mockResolvedValue(output([vscode]))
  mocks.realpath.mockRejectedValue(Object.assign(new Error('无权读取目录'), { code: 'EACCES' }))
  await assert.rejects(getProjectApps(), /无法识别本机应用.*无权读取目录/)
})

test('合并进行中的查询，完成后不永久缓存，下次查询反映卸载', async () => {
  let resolve!: (value: ReturnType<typeof output>) => void
  mocks.execute.mockReturnValueOnce(new Promise((done) => (resolve = done)))
  const first = getProjectApps()
  const second = getProjectApps()
  assert.equal(mocks.execute.mock.calls.length, 1)
  resolve(output([vscode]))
  assert.deepEqual(await first, [manager, { id: 'vscode', name: 'Visual Studio Code' }])
  assert.deepEqual(await second, await first)
  assert.deepEqual(await getProjectApps(), [manager])
  assert.equal(mocks.execute.mock.calls.length, 2)
})

test.each(['unknown', 'finder', '../vscode', { id: 'vscode' }, null])('拒绝未知或非编辑器 ID：%j', async (id) => {
  await assert.rejects(openProjectInApp(id, '/work/project'), /打开方式无效/)
  assert.equal(mocks.execute.mock.calls.length, 0)
})

test('打开前重新识别应用，卸载后报错且不自动打开其他应用', async () => {
  mocks.execute.mockResolvedValueOnce(output([vscode])).mockResolvedValueOnce(output([]))
  await getProjectApps()
  await assert.rejects(openProjectInApp('vscode', '/work/project'), /Visual Studio Code 未安装或已不可用/)
  assert.equal(mocks.execute.mock.calls.length, 2)
  assert.equal(
    mocks.execute.mock.calls.some(([executable]) => executable === '/usr/bin/open'),
    false,
  )
})

test('使用应用真实路径和独立参数打开含中文、空格及 Shell 字符的项目', async () => {
  mocks.execute.mockResolvedValueOnce(output([vscode])).mockResolvedValueOnce({ stdout: '', stderr: '' })
  mocks.realpath.mockResolvedValue('/Users/用户/Apps/Visual Studio Code.app')
  const cwd = '/work/中文 project; $(touch forbidden)'
  await openProjectInApp('vscode', cwd)
  assert.deepEqual(mocks.execute.mock.calls[1], [
    '/usr/bin/open',
    ['-a', '/Users/用户/Apps/Visual Studio Code.app', cwd],
    { timeout: 5000, maxBuffer: 256 * 1024 },
  ])
})

test('启动失败保留明确应用错误，不尝试其他启动方式', async () => {
  mocks.execute.mockResolvedValueOnce(output([vscode])).mockRejectedValueOnce(new Error('open 退出码 1'))
  await assert.rejects(openProjectInApp('vscode', '/work/project'), /Visual Studio Code 无法打开项目.*退出码 1/)
  assert.equal(mocks.execute.mock.calls.length, 2)
})
