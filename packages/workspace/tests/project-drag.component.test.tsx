import '@testing-library/jest-dom/vitest'
import type { ComponentProps, ReactNode } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ProjectsSection } from '../src/ui/sidebar/projects-section'

vi.mock('../src/ui/sidebar/sidebar-menus', () => ({
  SidebarRowMenu: ({ children }: { children: ReactNode }) => children,
  SidebarMoreMenu: () => <button type="button">更多</button>,
}))

afterEach(cleanup)

function renderProjects(reorderEnabled = true) {
  const props = {
    entries: ['alpha', 'beta'].map((name) => ({
      kind: 'project' as const,
      key: name,
      serviceId: 'local',
      project: { cwd: `/work/${name}`, name, sessions: [], sessionCount: 0, lastModified: '' },
    })),
    collapsed: false,
    onToggle: vi.fn(),
    showAllProjects: true,
    onToggleAllProjects: vi.fn(),
    ready: true,
    onDirectory: vi.fn(),
    projectProps: {
      cwd: '/work/alpha',
      onNewSessionInProject: vi.fn(),
      onSwitchSession: vi.fn(),
      onTogglePin: vi.fn(),
      onPrefetchSession: vi.fn(),
    },
    expandedProjects: new Set<string>(),
    expandedProjectItemLimits: new Set<string>(),
    toggleProject: vi.fn(),
    toggleProjectItems: vi.fn(),
    onSelectProject: vi.fn(),
    sortable: true,
    reorderEnabled,
    onReorder: vi.fn(),
    onReorderSessions: vi.fn(),
  } satisfies ComponentProps<typeof ProjectsSection>
  const { container } = render(<ProjectsSection {...props} />)
  const rows = [...container.querySelectorAll<HTMLElement>('[data-project-cwd]')]
  return { props, rows }
}

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

test('项目背景、图标和名称都能开始拖拽并调整顺序，不再显示独立手柄', () => {
  const { props, rows } = renderProjects()
  expect(screen.queryByRole('button', { name: '拖动排序，方向键上下移动' })).not.toBeInTheDocument()
  for (const source of [rows[0], rows[0].querySelector('svg')!, screen.getByText('alpha')]) {
    const dataTransfer = createTransfer()
    fireEvent.pointerDown(source)
    expect(fireEvent.dragStart(source, { dataTransfer })).toBe(true)
    expect(dataTransfer.effectAllowed).toBe('move')
    fireEvent.dragOver(rows[1], { dataTransfer })
    expect(dataTransfer.dropEffect).toBe('move')
    fireEvent.drop(rows[1], { dataTransfer })
    expect(props.onReorder).toHaveBeenLastCalledWith(['beta', 'alpha'])
  }
  expect(props.onSelectProject).not.toHaveBeenCalled()
})

test('项目名称仍可点击，右侧操作按钮不会发起拖拽或触发排序', () => {
  const { props, rows } = renderProjects()
  fireEvent.click(screen.getByRole('button', { name: 'alpha' }))
  expect(props.onSelectProject).toHaveBeenCalledExactlyOnceWith('/work/alpha')
  const create = screen.getByRole('button', { name: '在项目中新建会话：alpha' })
  const pin = screen.getByRole('button', { name: '置顶项目：alpha' })
  const more = rows[0].querySelector('[data-sidebar-drag-ignore] button:last-child')!
  for (const button of [create, pin, more]) {
    const dataTransfer = createTransfer()
    fireEvent.pointerDown(button.querySelector('svg') ?? button)
    expect(fireEvent.dragStart(rows[0], { dataTransfer })).toBe(false)
    expect(dataTransfer.setData).not.toHaveBeenCalled()
    fireEvent.keyDown(button, { key: 'ArrowDown' })
  }
  fireEvent.click(create)
  fireEvent.click(pin)
  expect(props.projectProps.onNewSessionInProject).toHaveBeenCalledExactlyOnceWith('/work/alpha')
  expect(props.projectProps.onTogglePin).toHaveBeenCalledExactlyOnceWith('/work/alpha')
  expect(props.onSelectProject).toHaveBeenCalledTimes(1)
  expect(props.onReorder).not.toHaveBeenCalled()
})

test('项目按钮保留方向键排序，禁用排序时不允许拖拽或键盘移动', () => {
  const { props } = renderProjects()
  fireEvent.keyDown(screen.getByRole('button', { name: 'alpha' }), { key: 'ArrowDown' })
  expect(props.onReorder).toHaveBeenCalledExactlyOnceWith(['beta', 'alpha'])
  cleanup()
  const disabled = renderProjects(false)
  const dataTransfer = createTransfer()
  expect(disabled.rows[0]).toHaveAttribute('draggable', 'false')
  expect(fireEvent.dragStart(disabled.rows[0], { dataTransfer })).toBe(false)
  fireEvent.keyDown(screen.getByRole('button', { name: 'alpha' }), { key: 'ArrowDown' })
  expect(disabled.props.onReorder).not.toHaveBeenCalled()
  expect(dataTransfer.setData).not.toHaveBeenCalled()
})
