import '@testing-library/jest-dom/vitest'
import type { ComponentProps } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

test('不支持本机项目时只禁用打开子菜单，保留会话操作', () => {
  const props = renderWorkspaceHeader({ canOpenProject: false })
  openSessionMenu()
  expect(screen.getByRole('menuitem', { name: '在…打开' })).toHaveAttribute('aria-disabled', 'true')
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
