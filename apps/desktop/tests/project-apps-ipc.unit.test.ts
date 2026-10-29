import assert from 'node:assert/strict'
import { beforeEach, test, vi } from 'vitest'
import { registerPlatformIpc } from '../src/main/ipc/register'
import { recoveryUrl } from '../src/main/window/recovery-page'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  getProjectApps: vi.fn(),
  openProjectInApp: vi.fn(),
  realpath: vi.fn(),
  stat: vi.fn(),
  openPath: vi.fn(),
}))
vi.mock('electron', () => ({
  app: { on: () => {} },
  ipcMain: {
    handle: (channel: string, callback: (event: unknown, ...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, callback),
    removeHandler: () => {},
  },
  dialog: {},
  shell: { openPath: mocks.openPath },
}))
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  realpath: mocks.realpath,
  stat: mocks.stat,
}))
vi.mock('../src/main/project-apps', () => ({
  getProjectApps: mocks.getProjectApps,
  openProjectInApp: mocks.openProjectInApp,
}))

beforeEach(() => {
  vi.resetAllMocks()
  mocks.handlers.clear()
  mocks.getProjectApps.mockResolvedValue([{ id: 'finder', name: '系统文件管理器' }])
  mocks.realpath.mockImplementation(async (value: string) => value)
  mocks.stat.mockResolvedValue({ isDirectory: () => true })
  mocks.openPath.mockResolvedValue('')
})
function setup(local = true) {
  const frame = { url: 'http://127.0.0.1:3000/' }
  const webContents = { mainFrame: frame }
  registerPlatformIpc(
    () => ({ webContents }) as never,
    async () => ({ hostId: 'fixture', url: frame.url, token: '', local }),
    () => 'http://127.0.0.1:3000',
    async () => {},
    async () => {},
    { list: async () => [], remove: async () => {}, error: () => null },
  )
  return { frame, webContents, event: { sender: webContents, senderFrame: frame } }
}

for (const channel of ['platform:project-apps', 'platform:open-project']) {
  test(`${channel} 只接受可信主窗口主 Frame，不允许恢复页或远程页面`, () => {
    const f = setup()
    const invoke = mocks.handlers.get(channel)!
    for (const event of [
      { sender: {}, senderFrame: f.frame },
      { sender: f.webContents, senderFrame: { url: f.frame.url } },
    ])
      assert.throws(() => invoke(event, 'vscode', '/work/project'), /不允许/)
    for (const url of ['https://remote.example', 'file:///tmp/test.html', recoveryUrl]) {
      f.frame.url = url
      assert.throws(() => invoke(f.event, 'vscode', '/work/project'), /不允许/)
    }
    assert.equal(mocks.getProjectApps.mock.calls.length, 0)
    assert.equal(mocks.openProjectInApp.mock.calls.length, 0)
    assert.equal(mocks.openPath.mock.calls.length, 0)
  })

  test(`${channel} 拒绝非本机连接，不访问本机目录或发现应用`, async () => {
    const f = setup(false)
    await assert.rejects(
      async () => mocks.handlers.get(channel)!(f.event, 'vscode', '/work/project'),
      /远程 Host 不能调用本机文件操作/,
    )
    assert.equal(mocks.getProjectApps.mock.calls.length, 0)
    assert.equal(mocks.openProjectInApp.mock.calls.length, 0)
    assert.equal(mocks.realpath.mock.calls.length, 0)
  })
}

test('本机应用列表通过已有 IPC 返回发现结果，并保留发现错误', async () => {
  const f = setup()
  const invoke = mocks.handlers.get('platform:project-apps')!
  assert.deepEqual(await invoke(f.event), [{ id: 'finder', name: '系统文件管理器' }])
  mocks.getProjectApps.mockRejectedValueOnce(new Error('无法识别本机应用：查询超时'))
  await assert.rejects(async () => invoke(f.event), /无法识别本机应用.*查询超时/)
})

test.each([null, 123, {}, 'relative/project'])('项目打开拒绝非绝对目录参数：%j', async (input) => {
  const f = setup()
  await assert.rejects(
    async () => mocks.handlers.get('platform:open-project')!(f.event, 'vscode', input),
    /本机项目路径无效/,
  )
  assert.equal(mocks.realpath.mock.calls.length, 0)
  assert.equal(mocks.openProjectInApp.mock.calls.length, 0)
})

test('打开路径必须存在且是普通文件或目录，检查通过前不启动应用', async () => {
  const f = setup()
  const invoke = mocks.handlers.get('platform:open-project')!
  mocks.realpath.mockRejectedValueOnce(Object.assign(new Error('项目不存在'), { code: 'ENOENT' }))
  await assert.rejects(async () => invoke(f.event, 'vscode', '/work/missing'), /项目不存在/)
  mocks.stat.mockResolvedValueOnce({ isDirectory: () => false, isFile: () => false })
  await assert.rejects(async () => invoke(f.event, 'vscode', '/work/socket'), /所选路径不是普通文件或文件夹/)
  assert.equal(mocks.openProjectInApp.mock.calls.length, 0)
  assert.equal(mocks.openPath.mock.calls.length, 0)
})

test('变更文件可以通过编辑器打开', async () => {
  const f = setup()
  mocks.stat.mockResolvedValueOnce({ isDirectory: () => false, isFile: () => true })
  await mocks.handlers.get('platform:open-project')!(f.event, 'vscode', '/work/source.ts')
  assert.deepEqual(mocks.openProjectInApp.mock.calls, [['vscode', '/work/source.ts']])
})

test('编辑器只接收校验后的项目真实路径，应用选择错误不会退回文件管理器', async () => {
  const f = setup()
  const invoke = mocks.handlers.get('platform:open-project')!
  mocks.realpath.mockResolvedValue('/work/真实 project')
  await invoke(f.event, 'vscode', '/work/link')
  assert.deepEqual(mocks.openProjectInApp.mock.calls, [['vscode', '/work/真实 project']])
  mocks.openProjectInApp.mockRejectedValueOnce(new Error('项目打开方式无效'))
  await assert.rejects(async () => invoke(f.event, 'unknown', '/work/link'), /项目打开方式无效/)
  mocks.openProjectInApp.mockRejectedValueOnce(new Error('Visual Studio Code 未安装或已不可用'))
  await assert.rejects(async () => invoke(f.event, 'vscode', '/work/link'), /未安装或已不可用/)
  assert.equal(mocks.openPath.mock.calls.length, 0)
})

test('系统文件管理器继续使用 shell.openPath，并保留系统打开失败错误', async () => {
  const f = setup()
  const invoke = mocks.handlers.get('platform:open-project')!
  mocks.realpath.mockResolvedValue('/work/真实 project')
  await invoke(f.event, 'finder', '/work/link')
  assert.deepEqual(mocks.openPath.mock.calls, [['/work/真实 project']])
  assert.equal(mocks.openProjectInApp.mock.calls.length, 0)
  assert.equal(mocks.getProjectApps.mock.calls.length, 0)
  mocks.openPath.mockResolvedValueOnce('系统拒绝打开')
  await assert.rejects(async () => invoke(f.event, 'finder', '/work/link'), /无法打开本机路径.*系统拒绝打开/)
})
