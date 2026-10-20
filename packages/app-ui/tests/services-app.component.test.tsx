import { useEffect } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { HostService } from '@pi-meme/contracts/host'
import { TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'
import type { ServiceController, ServiceRegistry, ServiceUI } from '../src/shell/service-ui'
import { ServicesApp } from '../src/shell/services-app'

const controllers = new Map<string, ServiceController>()

vi.mock('../src/app', () => ({
  App: ({ serviceUI }: { serviceUI: ServiceUI }) => {
    const { serviceId, onController } = serviceUI
    useEffect(() => {
      onController(serviceId, controllers.get(serviceId)!)
    }, [serviceId, onController])
    return serviceUI.active ? (
      <div data-testid="active-service" data-service={serviceId}>
        {serviceUI.sidebar}
      </div>
    ) : null
  },
}))

vi.mock('../src/shell/remote-settings', () => ({ RemoteSettings: () => null }))

afterEach(() => {
  cleanup()
  controllers.clear()
})

async function setup(target: string, status: HostService['status']) {
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
  for (const service of services) {
    controllers.set(service.id, {
      sessions: service.sessions,
      connection: { status: 'idle', cwd: '/project' },
      switchSession: vi.fn().mockResolvedValue(true),
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
  const registry = {
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
  return { controller: controllers.get(target)!, source: controllers.get('local')! }
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
  fireEvent.click(screen.getByText('local 会话 B'))
  await waitFor(() => expect(controller.switchSession).toHaveBeenCalledTimes(2))
  await act(async () => reject(new Error('旧会话失败')))
  expect(source.setError).not.toHaveBeenCalled()
})
