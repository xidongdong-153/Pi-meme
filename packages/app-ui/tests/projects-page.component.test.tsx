import '@testing-library/jest-dom/vitest'
import type { ComponentProps } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { DesktopProject, PiSessionsSnapshot } from '@pi-meme/contracts/sessions'
import { TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'
import { Sidebar } from '@pi-meme/workspace/ui/sidebar/sidebar'
import { ProjectsPage } from '../src/projects/projects-page'

afterEach(cleanup)

const projects: DesktopProject[] = [
  { cwd: '/work/alpha', name: 'Alpha 项目', lastSelectedAt: '2026-10-01T08:00:00.000Z' },
  { cwd: '/work/blog', name: 'Blog', lastSelectedAt: '2026-10-02T08:00:00.000Z' },
]
const sessions: PiSessionsSnapshot = {
  recents: [],
  pinnedPaths: [],
  projects: [
    {
      cwd: '/work/alpha',
      name: 'Alpha 项目',
      lastModified: '2026-10-01T09:00:00.000Z',
      sessionCount: 11,
      sessions: Array.from({ length: 11 }, (_, index) => ({
        id: `session-${index}`,
        path: `/sessions/${index}.jsonl`,
        cwd: '/work/alpha',
        name: `会话 ${index}`,
        messageCount: 2,
        created: '2026-10-01T08:00:00.000Z',
        modified: `2026-10-01T09:${String(59 - index).padStart(2, '0')}:00.000Z`,
      })),
    },
  ],
}

function renderPage(overrides: Partial<Omit<ComponentProps<typeof ProjectsPage>, 'bridge'>> = {}) {
  const props = {
    bridge: {
      getProjects: vi.fn(async () => projects),
      pickProjectDirectory: vi.fn(async () => '/work/new-project'),
      onSessionsChanged: vi.fn((_callback: () => void) => () => {}),
      getProjectApps: vi.fn(async () => [{ id: 'finder' as const, name: '系统文件管理器' }]),
      openProject: vi.fn(async () => {}),
      renameProject: vi.fn(async () => {}),
      previewProjectDeletion: vi.fn(async () => ({ paths: [], warnings: [] })),
      removeProject: vi.fn(async () => ({ deletedPaths: [], deletedKeys: [], errors: [] })),
      renameSession: vi.fn(async () => {}),
      deleteSession: vi.fn(async () => ({ deletedPaths: [], deletedKeys: [], errors: [] })),
    },
    sessions,
    nativeWindow: false,
    canOpenProject: false,
    rail: null,
    onDismiss: vi.fn(),
    onCreate: vi.fn(async (_input: { cwd: string; name: string }) => {}),
    onChanged: vi.fn(async () => {}),
    onDeleted: vi.fn(async () => {}),
    onNewSession: vi.fn(async () => {}),
    onSwitchSession: vi.fn(async () => {}),
    onTogglePin: vi.fn(async () => {}),
    onPrefetchSession: vi.fn(),
    ...overrides,
  } satisfies ComponentProps<typeof ProjectsPage>
  render(
    <TooltipProvider>
      <ProjectsPage {...props} />
    </TooltipProvider>,
  )
  return props
}

test('选择源目录后取消创建，不登记项目或切换聊天', async () => {
  const props = renderPage()
  fireEvent.click(screen.getByRole('button', { name: '创建' }))
  expect(screen.getByRole('button', { name: '创建项目' })).toBeDisabled()
  fireEvent.change(screen.getByRole('textbox', { name: '项目名称' }), { target: { value: '新项目' } })
  fireEvent.click(screen.getByRole('button', { name: '添加文件夹' }))
  await screen.findByText('/work/new-project')
  await waitFor(() => expect(screen.getByRole('button', { name: '取消' })).toBeEnabled())
  expect(props.bridge.pickProjectDirectory).toHaveBeenCalledOnce()
  expect(props.onCreate).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '取消' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(props.onCreate).not.toHaveBeenCalled()
  expect(props.onNewSession).not.toHaveBeenCalled()
})

test('提交自定义名称与目录，保存期间阻止重复提交，成功后刷新项目', async () => {
  let finish!: () => void
  const onCreate = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  const props = renderPage({ onCreate })
  fireEvent.click(screen.getByRole('button', { name: '创建' }))
  fireEvent.change(screen.getByRole('textbox', { name: '项目名称' }), { target: { value: '  我的项目  ' } })
  fireEvent.click(screen.getByRole('button', { name: '添加文件夹' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '创建项目' })).toBeEnabled())
  const form = screen.getByRole('textbox', { name: '项目名称' }).closest('form')!
  fireEvent.submit(form)
  fireEvent.submit(form)
  expect(onCreate).toHaveBeenCalledExactlyOnceWith({ cwd: '/work/new-project', name: '我的项目' })
  expect(screen.getByRole('button', { name: '正在创建…' })).toBeDisabled()
  await act(async () => finish())
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(props.onChanged).toHaveBeenCalledOnce()
})

test('创建失败保留名称和目录，可直接重试', async () => {
  const onCreate = vi.fn().mockRejectedValueOnce(new Error('目录不可用')).mockResolvedValue(undefined)
  renderPage({ onCreate })
  fireEvent.click(screen.getByRole('button', { name: '创建' }))
  fireEvent.change(screen.getByRole('textbox', { name: '项目名称' }), { target: { value: '我的项目' } })
  fireEvent.click(screen.getByRole('button', { name: '添加文件夹' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '创建项目' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: '创建项目' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('目录不可用')
  expect(screen.getByRole('textbox', { name: '项目名称' })).toHaveValue('我的项目')
  expect(screen.getByText('/work/new-project')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '创建项目' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(onCreate).toHaveBeenCalledTimes(2)
})

test('项目支持搜索名称和路径，按更新时间排序并展开会话的显式目标', async () => {
  const props = renderPage()
  await waitFor(() => expect(props.bridge.getProjects).toHaveBeenCalledOnce())
  expect(
    [...document.querySelectorAll('[data-project-cwd]')].map((row) => row.getAttribute('data-project-cwd')),
  ).toEqual(['/work/blog', '/work/alpha'])
  fireEvent.click(screen.getByRole('button', { name: '按更新时间从早到晚排序' }))
  expect(document.querySelector('[data-project-cwd]')).toHaveAttribute('data-project-cwd', '/work/alpha')
  fireEvent.change(screen.getByRole('textbox', { name: '搜索项目' }), { target: { value: '/WORK/ALPHA' } })
  expect(screen.queryByRole('button', { name: '展开项目：Blog' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '展开项目：Alpha 项目' }))
  expect(screen.queryByRole('button', { name: /^会话 10/ })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '展开显示' }))
  const session = screen.getByRole('button', { name: /^会话 10/ })
  fireEvent.focus(session)
  expect(props.onPrefetchSession).toHaveBeenCalledWith('/sessions/10.jsonl')
  fireEvent.click(session)
  await waitFor(() => expect(props.onSwitchSession).toHaveBeenCalledWith('/sessions/10.jsonl'))
  fireEvent.click(screen.getByRole('button', { name: '在项目中新建聊天：Alpha 项目' }))
  await waitFor(() => expect(props.onNewSession).toHaveBeenCalledWith('/work/alpha'))
  fireEvent.click(screen.getByRole('button', { name: '置顶项目：Alpha 项目' }))
  await waitFor(() => expect(props.onTogglePin).toHaveBeenCalledWith('/work/alpha'))
})

test.each([false, true])('项目页打开入口遵循本机能力=%s，复制路径始终保留', async (canOpenProject) => {
  const props = renderPage({ canOpenProject })
  const more = await screen.findByRole('button', { name: '更多操作：Alpha 项目' })
  fireEvent.keyDown(more, { key: 'ArrowDown' })
  expect(screen.getByRole('menuitem', { name: '复制项目路径' })).toBeInTheDocument()
  if (canOpenProject) {
    fireEvent.click(screen.getByRole('menuitem', { name: '在…打开' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '系统文件管理器' }))
    expect(props.bridge.openProject).toHaveBeenCalledWith('finder', '/work/alpha')
    expect(props.bridge.getProjectApps).toHaveBeenCalledOnce()
  } else {
    expect(screen.queryByRole('menuitem', { name: /在….*打开/ })).not.toBeInTheDocument()
    expect(props.bridge.getProjectApps).not.toHaveBeenCalled()
  }
})

test.each([false, true])('单服务回退侧栏也遵循本机打开能力=%s', (canOpenProject) => {
  const props = {
    canOpenProject,
    menuBridge: {
      getProjectApps: vi.fn(async () => [{ id: 'finder' as const, name: '系统文件管理器' }]),
      openProject: vi.fn(async () => {}),
      renameProject: vi.fn(async () => {}),
      previewProjectDeletion: vi.fn(async () => ({ paths: [], warnings: [] })),
      removeProject: vi.fn(async () => ({ deletedPaths: [], deletedKeys: [], errors: [] })),
      renameSession: vi.fn(async () => {}),
      deleteSession: vi.fn(async () => ({ deletedPaths: [], deletedKeys: [], errors: [] })),
    },
    onSelectProject: vi.fn(),
    onMenuChanged: vi.fn(async () => {}),
    onMenuDeleted: vi.fn(async () => {}),
    projectName: 'Alpha 项目',
    cwd: '/work/alpha',
    ready: true,
    status: 'ready',
    sessionsSnapshot: sessions,
    sessionsLoading: false,
    onDirectory: vi.fn(),
    onNewSession: vi.fn(),
    onNewSessionInProject: vi.fn(),
    onSwitchSession: vi.fn(),
    onTogglePin: vi.fn(),
    onPrefetchSession: vi.fn(),
    onSettings: vi.fn(),
  }
  render(
    <TooltipProvider>
      <Sidebar {...props} />
    </TooltipProvider>,
  )
  fireEvent.keyDown(screen.getByRole('button', { name: '更多操作：Alpha 项目' }), { key: 'ArrowDown' })
  expect(screen.getByRole('menuitem', { name: '复制项目路径' })).toBeInTheDocument()
  expect(Boolean(screen.queryByRole('menuitem', { name: '在…打开' }))).toBe(canOpenProject)
  expect(props.menuBridge.getProjectApps).toHaveBeenCalledTimes(canOpenProject ? 1 : 0)
})

test('刷新期间保留项目行，读取失败保留列表并显示错误', async () => {
  let fail!: (cause: Error) => void
  const props = renderPage()
  await waitFor(() => expect(props.bridge.getProjects).toHaveBeenCalledOnce())
  const notify = props.bridge.onSessionsChanged.mock.calls[0][0]
  props.bridge.getProjects.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject
      }),
  )
  act(() => notify())
  expect(screen.getByRole('button', { name: '展开项目：Alpha 项目' })).toBeInTheDocument()
  expect(screen.getByLabelText('项目列表')).toHaveAttribute('aria-busy', 'true')
  await act(async () => fail(new Error('读取失败')))
  expect(screen.getByRole('button', { name: '展开项目：Alpha 项目' })).toBeInTheDocument()
  expect(screen.getByRole('alert')).toHaveTextContent('读取失败')
})
