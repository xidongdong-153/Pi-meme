import { useEffect } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { HostService } from '@pi-meme/contracts/host'
import { TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'
import type { ServiceController, ServiceRegistry, ServiceUI } from '../src/shell/service-ui'
import { ServicesApp } from '../src/shell/services-app'

const controllers = new Map<string, ServiceController>()
const removalErrors: unknown[] = []

vi.mock('../src/app', () => ({
  App: ({ serviceUI }: { serviceUI: ServiceUI }) => {
    const { serviceId, onController } = serviceUI
    useEffect(() => {
      onController(serviceId, controllers.get(serviceId)!)
    }, [serviceId, onController])
    return serviceUI.active ? (
      <div data-testid="active-service" data-service={serviceId}>
        <button type="button" onClick={() => serviceUI.onSchedules('remote')}>
          切换远程定时任务
        </button>
        {serviceUI.sidebar}
        {serviceUI.remoteSettings}
      </div>
    ) : null
  },
}))

vi.mock('../src/shell/remote-settings', () => ({
  RemoteSettings: ({ onRemove }: { onRemove: (id: string) => Promise<void> }) => (
    <button type="button" onClick={() => void onRemove('remote').catch((cause) => removalErrors.push(cause))}>
      移除测试连接
    </button>
  ),
}))

afterEach(() => {
  cleanup()
  controllers.clear()
  removalErrors.length = 0
})

async function setup(target: string, status: HostService['status'], remote: Partial<HostService> = {}) {
  const services: HostService[] = ['local', 'remote'].map((id) => ({
    id,
    hostId: id,
    address: id === 'local' ? 'http://127.0.0.1:31415' : 'https://remote.example.test',
    local: id === 'local',
    status: id === target ? status : 'connected',
    projects: [],
    sessions: {
      projects: [],
      pinnedPaths: [],
      recents: ['A', 'B'].map((name) => ({
        id: `${id}-${name}`,
        path: `/${id}-${name}.jsonl`,
        cwd: '/project',
        name: `${id} 会话 ${name}`,
        messageCount: 1,
        created: '2026-10-20T00:00:00Z',
        modified: '2026-10-20T00:00:00Z',
      })),
    },
  }))
  Object.assign(services[1], remote)
  for (const service of services) {
    controllers.set(service.id, {
      sessions: service.sessions,
      connection: { status: 'idle', cwd: '/project' },
      switchSession: vi.fn().mockResolvedValue(true),
      openSchedules: vi.fn(),
      captureDraft: vi.fn(),
      clearDraft: vi.fn(),
      setError: vi.fn(),
    } as unknown as ServiceController)
  }
  const preferences = {
    groupMode: 'projects',
    sortMode: 'recent',
    collapsed: { pinned: false, projects: false, recents: false },
    orders: { projects: [], pinned: [] },
  }
  const bridge = {
    getSettings: async () => ({ settings: { sidebar: preferences } }),
    saveSidebarPreferences: vi.fn().mockResolvedValue(preferences),
    prefetchSession: vi.fn().mockResolvedValue(undefined),
  }
  const client = { bridge }
  const removeSsh = vi.fn().mockResolvedValue(undefined)
  const registry = {
    ssh: { remove: removeSsh },
    localServiceId: 'local',
    local: client,
    list: () => services,
    get: () => client,
    subscribe: () => () => {},
    initialize: async () => {},
  } as unknown as ServiceRegistry
  render(
    <TooltipProvider>
      <ServicesApp registry={registry} nativeWindow={false} />
    </TooltipProvider>,
  )
  await waitFor(() => expect(screen.getByText(`${target} 会话 A`)).toBeTruthy())
  await act(async () => {})
  return { controller: controllers.get(target)!, source: controllers.get('local')!, removeSsh }
}

test.each([
  ['local', 'connecting'],
  ['local', 'disconnected'],
  ['remote', 'connecting'],
  ['remote', 'disconnected'],
] as const)('服务 %s 的缓存状态为 %s 时仍能尝试切换会话', async (id, status) => {
  const { controller, source } = await setup(id, status)
  let finishSwitch!: (changed: boolean) => void
  vi.mocked(controller.switchSession).mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        finishSwitch = resolve
      }),
  )
  fireEvent.click(screen.getByText(`${id} 会话 A`))
  await waitFor(() => expect(controller.switchSession).toHaveBeenCalledExactlyOnceWith(`/${id}-A.jsonl`))
  expect(screen.getByTestId('active-service').getAttribute('data-service')).toBe('local')
  await act(async () => finishSwitch(true))
  await waitFor(() => expect(screen.getByTestId('active-service').getAttribute('data-service')).toBe(id))
  expect(source.setError).not.toHaveBeenCalled()
})

test('一个会话切换失败不阻止随后切换其他会话，也不自动重放失败操作', async () => {
  const { controller, source } = await setup('local', 'disconnected')
  vi.mocked(controller.switchSession).mockRejectedValueOnce(new Error('目标会话读取失败'))
  fireEvent.click(screen.getByText('local 会话 A'))
  await waitFor(() => expect(source.setError).toHaveBeenCalledWith('Error: 目标会话读取失败'))
  fireEvent.click(screen.getByText('local 会话 B'))
  await waitFor(() => expect(controller.switchSession).toHaveBeenCalledTimes(2))
  expect(controller.switchSession).toHaveBeenNthCalledWith(2, '/local-B.jsonl')
  expect(source.setError).toHaveBeenCalledTimes(1)
})

test('旧会话切换迟到的错误不覆盖后来成功切换的界面', async () => {
  const { controller, source } = await setup('local', 'connected')
  let reject!: (cause: Error) => void
  vi.mocked(controller.switchSession).mockImplementationOnce(
    () =>
      new Promise<boolean>((_, fail) => {
        reject = fail
      }),
  )
  fireEvent.click(screen.getByText('local 会话 A'))
  await waitFor(() => expect(controller.switchSession).toHaveBeenCalledTimes(1))
  fireEvent.click(screen.getByText('local 会话 B'))
  await waitFor(() => expect(controller.switchSession).toHaveBeenCalledTimes(2))
  await act(async () => reject(new Error('旧会话失败')))
  expect(source.setError).not.toHaveBeenCalled()
})

test('显式暂停的 SSH 会话保留摘要，但点击不会隐式恢复或切换', async () => {
  const { controller, source } = await setup('remote', 'disconnected', {
    transport: 'ssh',
    enabled: false,
    phase: 'paused',
  })
  fireEvent.click(screen.getByText('remote 会话 A'))
  await act(async () => {})
  expect(controller.switchSession).not.toHaveBeenCalled()
  expect(source.setError).toHaveBeenCalledWith('连接已暂停，请先在远程设置中恢复连接')
  expect(screen.getByTestId('active-service').getAttribute('data-service')).toBe('local')
})

test('移除 SSH 连接先检查目标未保存状态，不卸载或删除有草稿的连接', async () => {
  const { controller, removeSsh } = await setup('remote', 'connected', {
    transport: 'ssh',
    enabled: true,
    phase: 'connected',
  })
  controller.assertRemoveAllowed = vi.fn(() => {
    throw new Error('仍有未发送的草稿')
  })
  fireEvent.click(screen.getByRole('button', { name: '移除测试连接' }))
  await waitFor(() => expect(removalErrors).toHaveLength(1))
  expect(removeSsh).not.toHaveBeenCalled()
  expect(screen.getByText('remote 会话 A')).toBeTruthy()
  controller.assertRemoveAllowed = vi.fn()
  fireEvent.click(screen.getByRole('button', { name: '移除测试连接' }))
  await waitFor(() => expect(removeSsh).toHaveBeenCalledExactlyOnceWith('remote'))
})

test('正在编辑时激活切换其他服务或会话，自动取消编辑且不设置错误提示', async () => {
  const { controller, source } = await setup('remote', 'connected')
  source.editing = true
  source.workspaceDisabledReason = '请先完成或取消历史消息编辑'
  source.cancelEdit = vi.fn().mockImplementation(async () => {
    source.editing = false
    source.workspaceDisabledReason = undefined
  })
  fireEvent.click(screen.getByText('remote 会话 A'))
  await waitFor(() => expect(source.cancelEdit).toHaveBeenCalled())
  await waitFor(() => expect(controller.switchSession).toHaveBeenCalledExactlyOnceWith('/remote-A.jsonl'))
  expect(source.setError).not.toHaveBeenCalledWith('请先完成或取消历史消息编辑')
})

test('切换任务执行位置只打开目标任务页，不切换聊天或清空草稿', async () => {
  const { controller, source } = await setup('remote', 'connected')
  fireEvent.click(screen.getByRole('button', { name: '切换远程定时任务' }))
  await waitFor(() => expect(controller.openSchedules).toHaveBeenCalledOnce())
  expect(screen.getByTestId('active-service').getAttribute('data-service')).toBe('remote')
  expect(controller.switchSession).not.toHaveBeenCalled()
  expect(source.clearDraft).not.toHaveBeenCalled()
  expect(source.captureDraft).not.toHaveBeenCalled()
})
