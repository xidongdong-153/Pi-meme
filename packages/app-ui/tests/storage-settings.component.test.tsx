import '@testing-library/jest-dom/vitest'
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { DesktopStorageAdapter, DesktopStorageInfo } from '@pi-meme/contracts/storage'
import { StorageSettings } from '@pi-meme/settings/ui/storage-settings'

afterEach(cleanup)
const nativeInfo: DesktopStorageInfo = {
  hostId: 'local-host',
  dataRoot: '/data/local',
  source: 'default',
  canMaintain: true,
  cacheBytes: 2048,
  backupPaths: [],
}
function setup(overrides: Partial<DesktopStorageInfo> = {}, native = true) {
  const storage: DesktopStorageAdapter = {
    getInfo: vi.fn(async () => ({ ...nativeInfo, ...overrides })),
    chooseTarget: vi.fn(async () => ({
      selectionId: 'chosen',
      path: '/data/new',
      bytes: 1024,
      availableBytes: 1048576,
    })),
    migrate: vi.fn(async () => {}),
    clearCache: vi.fn(async () => {}),
    openDirectory: vi.fn(async () => {}),
  }
  const bridge = {
    getStorageInfo: vi.fn(async () => ({ hostId: 'local-host', dataRoot: '/data/local' })),
    storage: native ? storage : undefined,
  }
  const beforeRestart = vi.fn(async () => {})
  const maintaining = vi.fn()
  render(<StorageSettings bridge={bridge} onBeforeRestart={beforeRestart} onMaintaining={maintaining} />)
  return { storage, bridge, beforeRestart, maintaining }
}

test('复用 Host 显示维护禁用原因，允许打开目录但禁止迁移和清缓存', async () => {
  const f = setup({ canMaintain: false, maintenanceDisabledReason: '当前 Host 由其他入口管理，不能从 Desktop 维护。' })
  await screen.findByTestId('storage-root')
  expect(screen.getByText(/当前 Host 由其他入口管理/)).toBeVisible()
  expect(screen.getByRole('button', { name: '更改目录' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '清理缓存' })).toBeDisabled()
  await userEvent.setup().click(screen.getByRole('button', { name: '打开目录' }))
  expect(f.storage.openDirectory).toHaveBeenCalledWith({ expectedHostId: 'local-host', path: '/data/local' })
  expect(f.storage.migrate).not.toHaveBeenCalled()
  expect(f.storage.clearCache).not.toHaveBeenCalled()
})

test('Web 和远程只显示 Host 路径与配置说明，不暴露本机维护操作', async () => {
  setup({}, false)
  expect(await screen.findByTestId('storage-root')).toHaveTextContent('/data/local')
  expect(screen.getByText(/当前连接仅支持查看存储目录/)).toBeVisible()
  for (const name of ['更改目录', '清理缓存', '打开目录'])
    expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
})

test('选择新目录后先确认，取消不迁移，确认传递选择凭据和 Host 身份', async () => {
  const user = userEvent.setup()
  const f = setup()
  await screen.findByTestId('storage-root')
  await user.click(screen.getByRole('button', { name: '更改目录' }))
  let dialog = await screen.findByRole('dialog')
  expect(dialog).toHaveTextContent('/data/new')
  expect(f.storage.migrate).not.toHaveBeenCalled()
  await user.click(within(dialog).getByRole('button', { name: '取消' }))
  expect(f.storage.migrate).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: '更改目录' }))
  dialog = await screen.findByRole('dialog')
  await user.click(within(dialog).getByRole('button', { name: '迁移并重启' }))
  expect(f.beforeRestart).toHaveBeenCalledTimes(1)
  expect(f.storage.migrate).toHaveBeenCalledWith({ expectedHostId: 'local-host', selectionId: 'chosen' })
  expect(f.maintaining).toHaveBeenCalledWith(true)
})

test('未保存内容守卫阻止维护，错误可见且不会调用原生清理', async () => {
  const user = userEvent.setup()
  const f = setup()
  f.beforeRestart.mockRejectedValue(new Error('仍有草稿，请先处理'))
  await screen.findByTestId('storage-root')
  await user.click(screen.getByRole('button', { name: '清理缓存' }))
  const dialog = await screen.findByRole('dialog')
  expect(dialog).toHaveTextContent('2 KiB')
  await user.click(within(dialog).getByRole('button', { name: '清理并重启' }))
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('仍有草稿')
  expect(f.storage.clearCache).not.toHaveBeenCalled()
  expect(f.maintaining).not.toHaveBeenCalled()
})

test('清理请求只携带本机身份，原生错误保留内容并允许重试', async () => {
  const user = userEvent.setup()
  const f = setup()
  vi.mocked(f.storage.clearCache).mockRejectedValueOnce(new Error('仍有活动终端'))
  await screen.findByTestId('storage-root')
  await user.click(screen.getByRole('button', { name: '清理缓存' }))
  const dialog = await screen.findByRole('dialog')
  await user.click(within(dialog).getByRole('button', { name: '清理并重启' }))
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('活动终端')
  await user.click(within(dialog).getByRole('button', { name: '清理并重启' }))
  expect(f.storage.clearCache).toHaveBeenCalledTimes(2)
  expect(f.storage.clearCache).toHaveBeenCalledWith('local-host')
})

test.each([
  { source: 'environment' as const, canMaintain: false, cacheBytes: 2048 },
  { cacheBytes: 0 },
  { cacheBytes: null, cacheError: '权限不足' },
])('环境变量、零占用与统计失败不允许误清理：%j', async (info) => {
  setup(info)
  await screen.findByTestId('storage-root')
  expect(screen.getByRole('button', { name: '清理缓存' })).toBeDisabled()
  if (info.source === 'environment') expect(screen.getByRole('button', { name: '更改目录' })).toBeDisabled()
  if (info.cacheBytes === null) {
    expect(screen.getByText('占用统计不可用')).toBeVisible()
    expect(screen.getByRole('alert')).toHaveTextContent('权限不足')
  }
})

test('备份仅有打开入口，不混入清理或自动删除', async () => {
  const user = userEvent.setup()
  const f = setup({ backupPaths: ['/data/old'] })
  const backup = await screen.findByRole('region', { name: '迁移备份' })
  expect(backup).toHaveTextContent('会话和凭据')
  await user.click(within(backup).getByRole('button', { name: '打开备份' }))
  expect(f.storage.openDirectory).toHaveBeenCalledWith({ expectedHostId: 'local-host', path: '/data/old' })
  expect(within(backup).queryByRole('button', { name: /删除|清理/ })).not.toBeInTheDocument()
})

test('首次加载中保持对称骨架占位且不出现重试按钮，缓存卡片显示统计中', async () => {
  let resolveHost: (value: { hostId: string; dataRoot: string }) => void = () => {}
  const pendingHost = new Promise<{ hostId: string; dataRoot: string }>((resolve) => {
    resolveHost = resolve
  })
  const bridge = {
    getStorageInfo: vi.fn(() => pendingHost),
    storage: {
      getInfo: vi.fn(async () => nativeInfo),
      chooseTarget: vi.fn(async () => null),
      migrate: vi.fn(async () => {}),
      clearCache: vi.fn(async () => {}),
      openDirectory: vi.fn(async () => {}),
    },
  }
  render(<StorageSettings bridge={bridge} onBeforeRestart={async () => {}} onMaintaining={() => {}} />)

  expect(screen.getByTestId('storage-skeleton-root')).toBeVisible()
  expect(screen.getByTestId('storage-skeleton-status')).toBeVisible()
  expect(screen.getByText('正在统计…')).toBeVisible()
  expect(screen.queryByRole('button', { name: '重试读取' })).not.toBeInTheDocument()

  resolveHost({ hostId: 'local-host', dataRoot: '/data/local' })
  expect(await screen.findByTestId('storage-root')).toHaveTextContent('/data/local')
  expect(screen.queryByTestId('storage-skeleton-root')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '重试读取' })).not.toBeInTheDocument()
})

test('同一 Bridge 再次挂载直接从缓存同步渲染，零加载骨架', async () => {
  const bridge = {
    getStorageInfo: vi.fn(async () => ({ hostId: 'local-host', dataRoot: '/data/cached-root' })),
    storage: {
      getInfo: vi.fn(async () => ({ ...nativeInfo, dataRoot: '/data/cached-root' })),
      chooseTarget: vi.fn(async () => null),
      migrate: vi.fn(async () => {}),
      clearCache: vi.fn(async () => {}),
      openDirectory: vi.fn(async () => {}),
    },
  }
  const { unmount } = render(
    <StorageSettings bridge={bridge} onBeforeRestart={async () => {}} onMaintaining={() => {}} />,
  )
  expect(await screen.findByTestId('storage-root')).toHaveTextContent('/data/cached-root')

  unmount()

  render(<StorageSettings bridge={bridge} onBeforeRestart={async () => {}} onMaintaining={() => {}} />)
  // 同步挂载时即可立即查得数据，骨架屏不存在
  expect(screen.getByTestId('storage-root')).toHaveTextContent('/data/cached-root')
  expect(screen.queryByTestId('storage-skeleton-root')).not.toBeInTheDocument()
})

test('读取失败时展示错误提示与重试读取按钮，重试成功后恢复', async () => {
  const user = userEvent.setup()
  let succeed = false
  const bridge = {
    getStorageInfo: vi.fn(async () => {
      if (!succeed) throw new Error('网络断开')
      return { hostId: 'local-host', dataRoot: '/data/recovered' }
    }),
    storage: {
      getInfo: vi.fn(async () => nativeInfo),
      chooseTarget: vi.fn(async () => null),
      migrate: vi.fn(async () => {}),
      clearCache: vi.fn(async () => {}),
      openDirectory: vi.fn(async () => {}),
    },
  }
  render(<StorageSettings bridge={bridge} onBeforeRestart={async () => {}} onMaintaining={() => {}} />)

  expect(await screen.findByText('网络断开')).toBeVisible()
  const retryBtn = screen.getByRole('button', { name: '重试读取' })
  expect(retryBtn).toBeVisible()

  succeed = true
  await user.click(retryBtn)
  expect(await screen.findByTestId('storage-root')).toHaveTextContent('/data/recovered')
  expect(screen.queryByRole('button', { name: '重试读取' })).not.toBeInTheDocument()
})
