import '@testing-library/jest-dom/vitest'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ProjectApp } from '@pi-meme/contracts/desktop'
import type { HostService } from '@pi-meme/contracts/host'
import type { SidebarPreferences } from '@pi-meme/contracts/settings'
import { TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'
import { buildSidebarModel } from '@pi-meme/workspace/ui/sidebar/sidebar-model'
import { MultiServiceSidebar } from '../src/shell/multi-service-sidebar'

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
})

afterEach(cleanup)

function renderSidebar(
  pinned: boolean,
  preferencesLoaded = true,
  withSessions = false,
  nativePlatformAvailable = false,
  remote: Partial<HostService> = {},
) {
  const services: HostService[] = ['local', 'remote'].map((id) => ({
    id,
    hostId: id,
    local: id === 'local',
    address: `http://${id}.example.test:3000`,
    status: 'connected',
    projects: [],
    sessions: {
      projects: [{ cwd: '/work/project', name: `${id} 项目`, sessions: [], sessionCount: 0, lastModified: '' }],
      recents: withSessions
        ? [
            {
              id: `${id}-session`,
              name: `${id} 会话`,
              path: `/work/${id}-session.jsonl`,
              cwd: '/work/project',
              created: '2026-01-01',
              modified: '2026-01-01',
              messageCount: 0,
              workspaceKind: 'standalone',
            },
          ]
        : [],
      pinnedPaths: pinned ? ['/work/project', ...(withSessions ? [`/work/${id}-session.jsonl`] : [])] : [],
    },
  }))
  Object.assign(services[1], remote)
  const preferences: SidebarPreferences = {
    groupMode: 'projects',
    sortMode: 'recent',
    collapsed: { pinned: false, projects: false, recents: false },
    orders: {},
  }
  const model = buildSidebarModel(
    services.map((service) => ({ serviceId: service.id, snapshot: service.sessions! })),
    preferences,
  )
  const bridges = new Map(
    services.map((service) => [
      service.id,
      {
        prefetchSession: vi.fn().mockResolvedValue(undefined),
        getProjectApps: vi.fn(async (): Promise<ProjectApp[]> => [
          { id: 'finder', name: '系统文件管理器' },
          { id: 'cursor', name: 'Cursor' },
        ]),
        openProject: vi.fn(async () => {}),
      },
    ]),
  )
  const props = {
    services,
    registry: {
      ssh: {
        capabilities: vi.fn().mockResolvedValue({ canManage: true, available: true }),
        retry: vi.fn().mockResolvedValue(undefined),
        setEnabled: vi.fn().mockResolvedValue(undefined),
      },
      retry: vi.fn().mockResolvedValue(undefined),
      get: (id: string) => ({ bridge: bridges.get(id), nativePlatformAvailable }),
    } as unknown as ComponentProps<typeof MultiServiceSidebar>['registry'],
    controllers: new Map(),
    activeId: 'local',
    model,
    preferences,
    preferencesLoaded,
    preferenceError: '',
    onPreferencesChange: vi.fn(),
    onSearch: vi.fn(),
    onActivate: vi.fn(),
    onSettings: vi.fn(),
  } satisfies ComponentProps<typeof MultiServiceSidebar>
  const { container } = render(
    <TooltipProvider>
      <MultiServiceSidebar {...props} />
    </TooltipProvider>,
  )
  const rows = [...container.querySelectorAll<HTMLElement>('[data-project-cwd]')]
  const sessionRows = [...container.querySelectorAll<HTMLElement>('[data-session-path]')]
  return { props, rows, sessionRows, bridges }
}

test.each(['https', 'ssh'] as const)('%s 远程项目与会话显示来源，详情重试只操作所属连接', async (transport) => {
  const { props, rows, sessionRows } = renderSidebar(false, true, true, true, {
    transport,
    name: 'WSL Tailscale',
    status: 'disconnected',
    enabled: true,
    error: '连接被远端关闭',
    phase: 'action-required',
    sessions: {
      projects: [{ cwd: '/work/project', name: 'remote 项目', sessions: [], sessionCount: 7, lastModified: '' }],
      recents: [
        {
          id: 'remote-session',
          name: 'remote 会话',
          path: '/work/remote-session.jsonl',
          cwd: '/work/project',
          created: '2026-01-01',
          modified: '2026-01-01',
          messageCount: 0,
        },
      ],
      pinnedPaths: [],
    },
  })
  expect(rows[0].querySelector('[aria-label^="远程："]')).toBeNull()
  expect(rows[1].querySelector('[aria-label="远程：WSL Tailscale"]')).not.toBeNull()
  expect(rows[1].querySelector('[data-project-source-label]')).toHaveTextContent('WSL Tailscale')
  expect(sessionRows[1].querySelector('[aria-label="远程：WSL Tailscale"]')).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '远程项目详情：remote 项目' }))
  expect(
    await screen.findByText(`WSL Tailscale · ${transport === 'ssh' ? 'SSH' : 'HTTPS'} · 7 次聊天`),
  ).toBeInTheDocument()
  expect(screen.getByText('连接被远端关闭')).toBeInTheDocument()
  expect(screen.getByText('/work/project')).toBeInTheDocument()
  fireEvent.click(await screen.findByRole('button', { name: '重试连接：WSL Tailscale' }))
  await waitFor(() =>
    expect(transport === 'ssh' ? props.registry.ssh.retry : props.registry.retry).toHaveBeenCalledExactlyOnceWith(
      'remote',
    ),
  )
  expect(props.onActivate).not.toHaveBeenCalled()
})

test.each([
  { native: false, service: 'local', canOpen: false },
  { native: true, service: 'local', canOpen: true },
  { native: true, service: 'remote', canOpen: false },
])('native=$native 的 $service 项目右键菜单按本机能力显示入口，保留复制路径', async ({ native, service, canOpen }) => {
  const { rows, bridges } = renderSidebar(false, true, false, native)
  const bridge = bridges.get(service)!
  fireEvent.contextMenu(rows[service === 'local' ? 0 : 1])
  expect(screen.getByRole('menuitem', { name: '复制项目路径' })).toBeInTheDocument()
  expect(screen.getAllByRole('separator')).toHaveLength(1)
  if (canOpen) {
    fireEvent.click(screen.getByRole('menuitem', { name: '在…打开' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Cursor' }))
    expect(bridge.getProjectApps).toHaveBeenCalledOnce()
    expect(bridge.openProject).toHaveBeenCalledWith('cursor', '/work/project')
  } else {
    expect(screen.queryByRole('menuitem', { name: /在….*打开/ })).not.toBeInTheDocument()
    expect(bridge.getProjectApps).not.toHaveBeenCalled()
    expect(bridge.openProject).not.toHaveBeenCalled()
  }
})

test('侧栏初次识别不可点击且合并查询，成功和失败后均可刷新并保留已有列表', async () => {
  const { rows, bridges } = renderSidebar(false, true, false, true)
  const bridge = bridges.get('local')!
  let finish!: (apps: ProjectApp[]) => void
  let fail!: (cause: Error) => void
  bridge.getProjectApps.mockImplementationOnce(
    () =>
      new Promise<ProjectApp[]>((resolve) => {
        finish = resolve
      }),
  )
  const row = rows[0]
  fireEvent.contextMenu(row)
  fireEvent.click(screen.getByRole('menuitem', { name: '在…打开' }))
  expect(screen.getByRole('menuitem', { name: '正在识别应用…' })).toHaveAttribute('aria-disabled', 'true')
  expect(screen.queryByRole('menuitem', { name: /Finder|系统文件管理器/ })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('menuitem', { name: '新建会话' }))
  await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
  fireEvent.contextMenu(row)
  fireEvent.click(screen.getByRole('menuitem', { name: '在…打开' }))
  expect(bridge.getProjectApps).toHaveBeenCalledOnce()
  await act(async () => finish([{ id: 'cursor', name: 'Cursor' }]))
  expect(await screen.findByRole('menuitem', { name: 'Cursor' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('menuitem', { name: '新建会话' }))
  await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())

  bridge.getProjectApps.mockImplementationOnce(
    () =>
      new Promise<ProjectApp[]>((_resolve, reject) => {
        fail = reject
      }),
  )
  fireEvent.contextMenu(row)
  fireEvent.click(screen.getByRole('menuitem', { name: '在…打开' }))
  expect(screen.getByRole('menuitem', { name: 'Cursor' })).toBeInTheDocument()
  expect(bridge.getProjectApps).toHaveBeenCalledTimes(2)
  await act(async () => fail(new Error('probe failed')))
  expect(screen.getByRole('alert')).toHaveTextContent('无法识别本机应用：probe failed')
  expect(screen.getByRole('menuitem', { name: 'Cursor' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('menuitem', { name: '系统文件管理器' }))
  expect(bridge.openProject).toHaveBeenCalledWith('finder', '/work/project')
  await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())

  fireEvent.contextMenu(row)
  fireEvent.click(screen.getByRole('menuitem', { name: '在…打开' }))
  await waitFor(() => expect(bridge.getProjectApps).toHaveBeenCalledTimes(3))
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
})

function createTransfer() {
  const values = new Map<string, string>()
  return {
    effectAllowed: 'none',
    dropEffect: 'none',
    get types() {
      return [...values.keys()]
    },
    setData: vi.fn((type: string, value: string) => values.set(type, value)),
    getData: (type: string) => values.get(type) ?? '',
  }
}

test.each([false, true])('多服务侧边栏置顶=%s 的项目拖拽按服务标识保存顺序', (pinned) => {
  const { props, rows } = renderSidebar(pinned)
  expect(screen.queryByRole('button', { name: '拖动排序，方向键上下移动' })).not.toBeInTheDocument()
  for (const row of rows) {
    expect(row).toHaveAttribute('draggable', 'true')
  }
  const listKey = pinned ? 'pinned' : 'projects'
  const keys = props.model[listKey].map((entry) => entry.key)
  const source = screen.getByText('local 项目')
  const dataTransfer = createTransfer()
  fireEvent.pointerDown(source)
  fireEvent.dragStart(source, { dataTransfer })
  expect(dataTransfer.effectAllowed).toBe('move')
  fireEvent.dragOver(rows[1], { dataTransfer })
  expect(dataTransfer.dropEffect).toBe('move')
  fireEvent.drop(rows[1], { dataTransfer })
  expect(props.onPreferencesChange).toHaveBeenLastCalledWith({ orders: { [listKey]: [keys[1], keys[0]] } })
  expect(props.onActivate).not.toHaveBeenCalled()
})

test('置顶会话从行内拖拽并支持方向键排序，操作按钮不触发排序', () => {
  const { props, sessionRows } = renderSidebar(true, true, true)
  expect(screen.queryByRole('button', { name: '拖动排序，方向键上下移动' })).not.toBeInTheDocument()
  const [source, target] = sessionRows
  expect(source).toHaveAttribute('draggable', 'true')
  const keys = props.model.pinned.map((entry) => entry.key)
  const sourceKey = source.closest<HTMLElement>('[data-sidebar-item-key]')!.dataset.sidebarItemKey!
  const targetKey = target.closest<HTMLElement>('[data-sidebar-item-key]')!.dataset.sidebarItemKey!
  const reordered = keys.filter((key) => key !== sourceKey)
  reordered.splice(keys.indexOf(targetKey), 0, sourceKey)
  const dataTransfer = createTransfer()
  fireEvent.pointerDown(screen.getByText('local 会话'))
  fireEvent.dragStart(source, { dataTransfer })
  fireEvent.dragOver(target, { dataTransfer })
  fireEvent.drop(target, { dataTransfer })
  expect(props.onPreferencesChange).toHaveBeenLastCalledWith({ orders: { pinned: reordered } })

  props.onPreferencesChange.mockClear()
  fireEvent.keyDown(screen.getByRole('button', { name: 'local 会话' }), { key: 'ArrowDown' })
  expect(props.onPreferencesChange).toHaveBeenCalledOnce()
  props.onPreferencesChange.mockClear()
  const unpin = screen.getByRole('button', { name: '取消置顶：local 会话' })
  for (const button of [unpin]) {
    const blockedTransfer = createTransfer()
    fireEvent.pointerDown(button)
    expect(fireEvent.dragStart(source, { dataTransfer: blockedTransfer })).toBe(false)
    fireEvent.keyDown(button, { key: 'ArrowDown' })
    expect(blockedTransfer.setData).not.toHaveBeenCalled()
  }
  expect(props.onPreferencesChange).not.toHaveBeenCalled()
  expect(props.onActivate).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'local 会话' }))
  expect(props.onActivate).toHaveBeenCalledExactlyOnceWith('local', expect.any(Function))
})

test('偏好读取完成前禁止置顶会话行内排序', () => {
  const { props, sessionRows } = renderSidebar(true, false, true)
  const dataTransfer = createTransfer()
  expect(sessionRows[0]).toHaveAttribute('draggable', 'false')
  expect(fireEvent.dragStart(sessionRows[0], { dataTransfer })).toBe(false)
  fireEvent.keyDown(screen.getByRole('button', { name: 'local 会话' }), { key: 'ArrowDown' })
  expect(dataTransfer.setData).not.toHaveBeenCalled()
  expect(props.onPreferencesChange).not.toHaveBeenCalled()
})

test('多服务项目操作按钮不触发拖拽，点击新建仍使用所属服务', () => {
  const { props, rows } = renderSidebar(false)
  const create = screen.getByRole('button', { name: '在项目中新建会话：remote 项目' })
  const pin = screen.getByRole('button', { name: '置顶项目：remote 项目' })
  for (const button of [create, pin]) {
    const dataTransfer = createTransfer()
    fireEvent.pointerDown(button.querySelector('svg') ?? button)
    expect(fireEvent.dragStart(rows[1], { dataTransfer })).toBe(false)
    expect(dataTransfer.setData).not.toHaveBeenCalled()
    fireEvent.keyDown(button, { key: 'ArrowDown' })
  }
  expect(props.onPreferencesChange).not.toHaveBeenCalled()
  fireEvent.click(create)
  expect(props.onActivate).toHaveBeenCalledExactlyOnceWith('remote', expect.any(Function))
})

test.each([false, true])('多服务侧边栏置顶=%s 在偏好读取完成前禁止项目拖拽', (pinned) => {
  const { props, rows } = renderSidebar(pinned, false)
  const dataTransfer = createTransfer()
  expect(rows[0]).toHaveAttribute('draggable', 'false')
  expect(fireEvent.dragStart(rows[0], { dataTransfer })).toBe(false)
  fireEvent.keyDown(screen.getByRole('button', { name: 'local 项目' }), { key: 'ArrowDown' })
  expect(dataTransfer.setData).not.toHaveBeenCalled()
  expect(props.onPreferencesChange).not.toHaveBeenCalled()
})

test('点击侧栏新建项目触发活动控制器的打开弹框回调', () => {
  const openProjectDialog = vi.fn()
  const controllers = new Map([
    [
      'local',
      {
        openProjectDialog,
        chooseDirectory: vi.fn(),
      } as unknown as import('../src/shell/service-ui').ServiceController,
    ],
  ])
  const services: HostService[] = [
    {
      id: 'local',
      hostId: 'local',
      local: true,
      address: 'http://local.example.test:3000',
      status: 'connected',
      projects: [],
      sessions: { projects: [], recents: [], pinnedPaths: [] },
    },
  ]
  const preferences: SidebarPreferences = {
    groupMode: 'projects',
    sortMode: 'recent',
    collapsed: { pinned: false, projects: false, recents: false },
    orders: {},
  }
  const model = buildSidebarModel(
    services.map((service) => ({ serviceId: service.id, snapshot: service.sessions! })),
    preferences,
  )
  render(
    <TooltipProvider>
      <MultiServiceSidebar
        services={services}
        registry={{ get: () => ({ bridge: {} as never, nativePlatformAvailable: false }) } as never}
        controllers={controllers}
        activeId="local"
        model={model}
        preferences={preferences}
        preferencesLoaded
        preferenceError=""
        onPreferencesChange={vi.fn()}
        onSearch={vi.fn()}
        onActivate={vi.fn()}
        onSettings={vi.fn()}
      />
    </TooltipProvider>,
  )
  fireEvent.click(screen.getByRole('button', { name: '新建项目' }))
  expect(openProjectDialog).toHaveBeenCalledOnce()
})
