import '@testing-library/jest-dom/vitest'
import type { ComponentProps } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { HostService } from '@pi-meme/contracts/host'
import type { SidebarPreferences } from '@pi-meme/contracts/settings'
import { TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'
import { buildSidebarModel } from '@pi-meme/workspace/ui/sidebar/sidebar-model'
import { MultiServiceSidebar } from '../src/shell/multi-service-sidebar'

afterEach(cleanup)

function renderSidebar(pinned: boolean, preferencesLoaded = true, withSessions = false) {
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
  const props = {
    services,
    registry: {
      get: () => ({ bridge: { prefetchSession: vi.fn().mockResolvedValue(undefined) } }),
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
  return { props, rows, sessionRows }
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

test.each([false, true])('多服务侧边栏置顶=%s 的项目直接从行内拖拽，不显示手柄或预留空白', (pinned) => {
  const { props, rows } = renderSidebar(pinned)
  expect(screen.queryByRole('button', { name: '拖动排序，方向键上下移动' })).not.toBeInTheDocument()
  for (const row of rows) {
    expect(row).toHaveAttribute('draggable', 'true')
    expect(row.closest('[data-sidebar-item-key]')).not.toHaveClass('pl-3')
  }
  const listKey = pinned ? 'pinned' : 'projects'
  const keys = props.model[listKey].map((entry) => entry.key)
  for (const source of [rows[0], rows[0].querySelector('svg')!, screen.getByText('local 项目')]) {
    const dataTransfer = createTransfer()
    fireEvent.pointerDown(source)
    fireEvent.dragStart(source, { dataTransfer })
    expect(dataTransfer.effectAllowed).toBe('move')
    fireEvent.dragOver(rows[1], { dataTransfer })
    expect(dataTransfer.dropEffect).toBe('move')
    fireEvent.drop(rows[1], { dataTransfer })
    expect(props.onPreferencesChange).toHaveBeenLastCalledWith({ orders: { [listKey]: [keys[1], keys[0]] } })
  }
  expect(props.onActivate).not.toHaveBeenCalled()
})

test('置顶会话从行内拖拽并支持方向键排序，操作按钮不触发排序', () => {
  const { props, sessionRows } = renderSidebar(true, true, true)
  expect(screen.queryByRole('button', { name: '拖动排序，方向键上下移动' })).not.toBeInTheDocument()
  const [source, target] = sessionRows
  expect(source).toHaveAttribute('draggable', 'true')
  expect(source.closest('[data-sidebar-item-key]')).not.toHaveClass('pl-3')
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
  const more = screen.getByRole('button', { name: '更多操作：local 会话' })
  for (const button of [unpin, more]) {
    const blockedTransfer = createTransfer()
    fireEvent.pointerDown(button)
    expect(fireEvent.dragStart(source, { dataTransfer: blockedTransfer })).toBe(false)
    fireEvent.keyDown(button, { key: 'ArrowDown' })
    expect(blockedTransfer.setData).not.toHaveBeenCalled()
  }
  expect(props.onPreferencesChange).not.toHaveBeenCalled()
  expect(props.onActivate).not.toHaveBeenCalled()
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
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
  const more = rows[1].querySelector('[data-sidebar-drag-ignore] button:last-child')!
  for (const button of [create, pin, more]) {
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
