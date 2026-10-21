import '@testing-library/jest-dom/vitest'
import type { ComponentProps } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ProjectApp } from '@pi-meme/contracts/desktop'
import { TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'
import { SidebarMenus } from '@pi-meme/workspace/ui/sidebar/sidebar-menus'
import { AppHeader } from '../src/layout/app-header'
import { PageHeader } from '../src/layout/page-header'

afterEach(cleanup)

function renderWorkspaceHeader(overrides: Partial<ComponentProps<typeof AppHeader>> = {}, pinnedPaths: string[] = []) {
  const props = {
    nativeWindow: false,
    canOpenProject: true,
    loadProjectApps: vi.fn(async () => [{ id: 'cursor' as const, name: 'Cursor' }]),
    sidebarOpen: true,
    onToggleSidebar: vi.fn(),
    busy: false,
    cwd: '/tmp/project',
    onDirectory: vi.fn(),
    project: '测试项目',
    title: '测试会话',
    session: {
      id: 'session-1',
      path: '/tmp/session.jsonl',
      cwd: '/tmp/project',
      name: '测试会话',
      messageCount: 2,
      created: '2026-01-01T00:00:00.000Z',
      modified: '2026-01-01T00:00:00.000Z',
    },
    canRenameSession: true,
    onOpenProject: vi.fn(),
    preferredApp: 'finder',
    onPreferredApp: vi.fn(),
    ...overrides,
  } satisfies ComponentProps<typeof AppHeader>
  const menuProps = {
    canOpenProject: props.canOpenProject,
    bridge: {
      getProjectApps: props.loadProjectApps,
      openProject: vi.fn(),
      renameProject: vi.fn(),
      previewProjectDeletion: vi.fn(),
      removeProject: vi.fn(),
      renameSession: vi.fn(async () => {}),
      deleteSession: vi.fn(),
    },
    pinnedPaths,
    onNewSession: vi.fn(),
    onTogglePin: vi.fn(),
    onChanged: vi.fn(async () => {}),
    onDeleted: vi.fn(),
  } satisfies Omit<ComponentProps<typeof SidebarMenus>, 'children'>

  render(
    <TooltipProvider>
      <SidebarMenus {...menuProps}>
        <PageHeader>
          <AppHeader {...props} />
        </PageHeader>
      </SidebarMenus>
    </TooltipProvider>,
  )
  return { ...props, ...menuProps }
}

function openSessionMenu() {
  const trigger = screen.getByRole('button', { name: '会话菜单' })
  fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  return trigger
}

test('共用顶栏保留侧栏开关和项目选择，省略号菜单按顺序提供会话操作', () => {
  const props = renderWorkspaceHeader()

  fireEvent.click(screen.getByRole('button', { name: '收起侧边栏' }))
  expect(props.onToggleSidebar).toHaveBeenCalledOnce()

  const directory = screen.getByRole('button', { name: '在顶栏选择项目' })
  fireEvent.click(directory)
  expect(props.onDirectory).toHaveBeenCalledWith(directory)

  openSessionMenu()
  expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['重命名', '置顶', '在…打开'])
})

test('在…打开通过二级菜单选择默认应用并打开项目', async () => {
  const props = renderWorkspaceHeader()
  openSessionMenu()
  expect(screen.queryByRole('menuitem', { name: 'Cursor' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('menuitem', { name: '在…打开' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Cursor' }))

  expect(props.loadProjectApps).toHaveBeenCalledOnce()
  expect(props.onPreferredApp).toHaveBeenCalledWith('cursor')
  expect(props.onOpenProject).toHaveBeenCalledWith('cursor')
  expect(screen.queryByRole('menuitem', { name: 'Cursor' })).not.toBeInTheDocument()
})

test('首次识别期间没有 Finder 占位，并合并进行中的查询', async () => {
  let finish!: (apps: ProjectApp[]) => void
  const loadProjectApps = vi.fn(
    () =>
      new Promise<ProjectApp[]>((resolve) => {
        finish = resolve
      }),
  )
  renderWorkspaceHeader({ loadProjectApps })
  const trigger = openSessionMenu()
  fireEvent.click(screen.getByRole('menuitem', { name: '在…打开' }))
  expect(screen.getByRole('menuitem', { name: '正在识别应用…' })).toHaveAttribute('aria-disabled', 'true')
  expect(screen.queryByRole('menuitem', { name: /Finder|系统文件管理器/ })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('menuitem', { name: '置顶' }))
  await waitFor(() => expect(trigger).toHaveFocus())
  openSessionMenu()
  expect(loadProjectApps).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('menuitem', { name: '在…打开' }))
  await act(async () => finish([{ id: 'cursor', name: 'Cursor' }]))
  expect(await screen.findByRole('menuitem', { name: 'Cursor' })).toBeInTheDocument()
  expect(screen.queryByRole('menuitem', { name: '正在识别应用…' })).not.toBeInTheDocument()
})

test('再次展开刷新时保留应用列表，已卸载的默认应用仅在显示上回退', async () => {
  const installed: ProjectApp[] = [
    { id: 'finder', name: '系统文件管理器' },
    { id: 'cursor', name: 'Cursor' },
  ]
  let finish!: (apps: ProjectApp[]) => void
  const loadProjectApps = vi
    .fn<() => Promise<ProjectApp[]>>()
    .mockResolvedValueOnce(installed)
    .mockImplementationOnce(
      () =>
        new Promise<ProjectApp[]>((resolve) => {
          finish = resolve
        }),
    )
    .mockResolvedValue(installed)
  const props = renderWorkspaceHeader({ loadProjectApps, preferredApp: 'cursor' })
  const trigger = openSessionMenu()
  fireEvent.click(screen.getByRole('menuitem', { name: '在…打开' }))
  expect(await screen.findByRole('menuitem', { name: 'Cursor默认' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('menuitem', { name: '置顶' }))
  await waitFor(() => expect(trigger).toHaveFocus())
  openSessionMenu()
  fireEvent.click(screen.getByRole('menuitem', { name: '在…打开' }))
  expect(screen.getByRole('menuitem', { name: 'Cursor默认' })).toBeInTheDocument()
  expect(loadProjectApps).toHaveBeenCalledTimes(2)
  await act(async () => finish([installed[0]]))
  expect(await screen.findByRole('menuitem', { name: '系统文件管理器默认' })).toBeInTheDocument()
  expect(screen.queryByRole('menuitem', { name: /Cursor/ })).not.toBeInTheDocument()
  expect(props.onPreferredApp).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('menuitem', { name: '置顶' }))
  await waitFor(() => expect(trigger).toHaveFocus())
  openSessionMenu()
  expect(loadProjectApps).toHaveBeenCalledTimes(3)
})

test('识别失败显示中文错误和可用的系统文件管理器，下次展开可以重试', async () => {
  const loadProjectApps = vi
    .fn<() => Promise<ProjectApp[]>>()
    .mockRejectedValueOnce(
      new Error("Error invoking remote method 'platform:project-apps': Error: 无法识别本机应用：probe failed"),
    )
    .mockResolvedValueOnce([{ id: 'cursor', name: 'Cursor' }])
  const props = renderWorkspaceHeader({ loadProjectApps, preferredApp: 'cursor' })
  const trigger = openSessionMenu()
  fireEvent.click(screen.getByRole('menuitem', { name: '在…打开' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(/^无法识别本机应用：probe failed$/)
  expect(screen.queryByRole('menuitem', { name: /Cursor/ })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('menuitem', { name: '系统文件管理器默认' }))
  expect(props.onOpenProject).toHaveBeenCalledWith('finder')
  await waitFor(() => expect(trigger).toHaveFocus())
  openSessionMenu()
  fireEvent.click(screen.getByRole('menuitem', { name: '在…打开' }))
  expect(await screen.findByRole('menuitem', { name: 'Cursor默认' })).toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(loadProjectApps).toHaveBeenCalledTimes(2)
})

test('重命名复用现有对话框，保存后刷新会话并恢复菜单按钮焦点', async () => {
  const props = renderWorkspaceHeader()
  const trigger = openSessionMenu()
  fireEvent.click(screen.getByRole('menuitem', { name: '重命名' }))

  const input = await screen.findByRole('textbox', { name: '名称' })
  expect(input).toHaveValue('测试会话')
  await waitFor(() => expect(input).toHaveFocus())
  fireEvent.change(input, { target: { value: '新会话名称' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))

  await waitFor(() => expect(props.bridge.renameSession).toHaveBeenCalledWith('/tmp/session.jsonl', '新会话名称'))
  expect(props.onChanged).toHaveBeenCalledOnce()
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  await waitFor(() => expect(trigger).toHaveFocus())
})

test.each([
  { pinnedPaths: [], label: '置顶' },
  { pinnedPaths: ['/tmp/session.jsonl'], label: '取消置顶' },
])('会话菜单支持$label', ({ pinnedPaths, label }) => {
  const props = renderWorkspaceHeader({}, pinnedPaths)
  openSessionMenu()
  fireEvent.click(screen.getByRole('menuitem', { name: label }))
  expect(props.onTogglePin).toHaveBeenCalledWith('/tmp/session.jsonl')
})

test('运行中的会话禁止重命名但仍可置顶', () => {
  const props = renderWorkspaceHeader({ canRenameSession: false })
  openSessionMenu()
  expect(screen.getByRole('menuitem', { name: '重命名' })).toHaveAttribute('aria-disabled', 'true')
  fireEvent.click(screen.getByRole('menuitem', { name: '置顶' }))
  expect(props.onTogglePin).toHaveBeenCalledWith('/tmp/session.jsonl')
})

test('尚无持久化会话时禁用重命名和置顶', () => {
  renderWorkspaceHeader({ session: undefined })
  openSessionMenu()
  expect(screen.getByRole('menuitem', { name: '重命名' })).toHaveAttribute('aria-disabled', 'true')
  expect(screen.getByRole('menuitem', { name: '置顶' })).toHaveAttribute('aria-disabled', 'true')
})

test('Web 或远程项目隐藏打开子菜单与分隔线，保留会话操作', () => {
  const props = renderWorkspaceHeader({ canOpenProject: false })
  openSessionMenu()
  expect(screen.queryByRole('menuitem', { name: '在…打开' })).not.toBeInTheDocument()
  expect(screen.queryByRole('separator')).not.toBeInTheDocument()
  expect(screen.getByRole('menuitem', { name: '重命名' })).not.toHaveAttribute('aria-disabled')
  fireEvent.click(screen.getByRole('menuitem', { name: '置顶' }))
  expect(props.onTogglePin).toHaveBeenCalledWith('/tmp/session.jsonl')
  expect(props.loadProjectApps).not.toHaveBeenCalled()
  expect(props.onOpenProject).not.toHaveBeenCalled()
})

test('连接忙碌时禁用项目选择并保留侧栏开关', () => {
  const props = renderWorkspaceHeader({ busy: true, canRenameSession: false })

  expect(screen.getByRole('button', { name: '后退' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '前进' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '在顶栏选择项目' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: '在顶栏选择项目' }))
  expect(props.onDirectory).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: '收起侧边栏' }))
  expect(props.onToggleSidebar).toHaveBeenCalledOnce()
  openSessionMenu()
  expect(screen.getByRole('menuitem', { name: '重命名' })).toHaveAttribute('aria-disabled', 'true')
  expect(screen.getByRole('menuitem', { name: '置顶' })).toHaveAttribute('aria-disabled', 'true')
})

test('共用顶栏保留返回分叉来源会话的操作', () => {
  const onOpenForkSource = vi.fn()
  renderWorkspaceHeader({ forkedFrom: { path: '/tmp/source.jsonl', title: '来源会话' }, onOpenForkSource })

  fireEvent.click(screen.getByRole('button', { name: '返回来源会话：来源会话' }))
  expect(onOpenForkSource).toHaveBeenCalledWith('/tmp/source.jsonl')
})
