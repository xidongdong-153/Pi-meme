import '@testing-library/jest-dom/vitest'
import type { ComponentProps } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'
import { AppHeader } from '../src/layout/app-header'
import { PageHeader } from '../src/layout/page-header'

afterEach(cleanup)

function renderWorkspaceHeader(overrides: Partial<ComponentProps<typeof AppHeader>> = {}) {
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
    onOpenProject: vi.fn(),
    preferredApp: 'finder',
    onPreferredApp: vi.fn(),
    ...overrides,
  } satisfies ComponentProps<typeof AppHeader>

  render(
    <TooltipProvider>
      <PageHeader>
        <AppHeader {...props} />
      </PageHeader>
    </TooltipProvider>,
  )
  return props
}

test('共用顶栏保留侧栏开关、项目选择和打开项目操作', () => {
  const props = renderWorkspaceHeader()

  fireEvent.click(screen.getByRole('button', { name: '收起侧边栏' }))
  expect(props.onToggleSidebar).toHaveBeenCalledOnce()

  const directory = screen.getByRole('button', { name: '在顶栏选择项目' })
  fireEvent.click(directory)
  expect(props.onDirectory).toHaveBeenCalledWith(directory)

  fireEvent.click(screen.getByRole('button', { name: '在 Finder 中打开项目' }))
  expect(props.onOpenProject).toHaveBeenCalledWith('finder')
})

test('打开应用菜单后仍可选择默认应用并打开项目', async () => {
  const props = renderWorkspaceHeader()
  fireEvent.click(screen.getByRole('button', { name: '选择打开项目的应用' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Cursor' }))

  expect(props.loadProjectApps).toHaveBeenCalledOnce()
  expect(props.onPreferredApp).toHaveBeenCalledWith('cursor')
  expect(props.onOpenProject).toHaveBeenCalledWith('cursor')
  expect(screen.queryByRole('button', { name: 'Cursor' })).not.toBeInTheDocument()
})

test('连接忙碌或不支持本机项目时，禁用对应操作并保留侧栏开关', () => {
  const props = renderWorkspaceHeader({ busy: true, canOpenProject: false })

  expect(screen.getByRole('button', { name: '后退' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '前进' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '在顶栏选择项目' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '在 Finder 中打开项目' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '选择打开项目的应用' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: '在顶栏选择项目' }))
  fireEvent.click(screen.getByRole('button', { name: '在 Finder 中打开项目' }))
  expect(props.onDirectory).not.toHaveBeenCalled()
  expect(props.onOpenProject).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: '收起侧边栏' }))
  expect(props.onToggleSidebar).toHaveBeenCalledOnce()
})

test('共用顶栏保留返回分叉来源会话的操作', () => {
  const onOpenForkSource = vi.fn()
  renderWorkspaceHeader({ forkedFrom: { path: '/tmp/source.jsonl', title: '来源会话' }, onOpenForkSource })

  fireEvent.click(screen.getByRole('button', { name: '返回来源会话：来源会话' }))
  expect(onOpenForkSource).toHaveBeenCalledWith('/tmp/source.jsonl')
})
