import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect, useState, type ReactNode } from 'react'
import type { HostApi } from '@pi-meme/contracts/app-host'
import type { UiPanel } from '@pi-meme/plugin-sdk/ui'
import { TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'
import { WorkspacePanels } from '../src/layout/workspace-panels'
import { defaultPanelLayout, panelStorageKey } from '../src/layout/panel-layout'
import { detectPlatform, ShortcutProvider } from '../src/shortcuts/shortcut-provider'
import { DEFAULT_PROFILE } from '../src/settings/user-profile'

afterEach(cleanup)

beforeEach(() => {
  window.localStorage.clear()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})

function Panes({
  onSidebar,
  panels = [],
  onNewSession,
  onPlugins,
  activity,
  session = 'chat',
  children = '聊天正文',
  onFocusComposer,
}: {
  onFocusComposer?: () => void
  children?: ReactNode
  activity?: { count: number; known: boolean }
  session?: string
  onSidebar?: (open: boolean, width: number) => void
  panels?: UiPanel[]
  onNewSession?: () => void
  onPlugins?: () => void
}) {
  const [open, setOpen] = useState(true)
  const [width, setWidth] = useState(256)
  return (
    <TooltipProvider>
      <WorkspacePanels
        onFocusComposer={onFocusComposer}
        profile={DEFAULT_PROFILE}
        profileLoading={false}
        panels={panels}
        activity={activity}
        onNewSession={onNewSession}
        onPlugins={onPlugins}
        props={{ host: {} as HostApi, target: { hostId: 'host' }, snapshot: null }}
        session={session}
        sidebar="会话列表"
        sidebarOpen={open}
        sidebarWidth={width}
        onSidebar={(next, size) => {
          onSidebar?.(next, size)
          setOpen(next)
          setWidth(size)
        }}
        header={(toggleSidebar, tabs) => (
          <>
            <button type="button" onClick={toggleSidebar}>
              切换侧栏
            </button>
            {tabs?.()}
          </>
        )}
      >
        {children}
      </WorkspacePanels>
    </TooltipProvider>
  )
}

function shell() {
  const node = document.querySelector('.workspace-panes')
  if (!(node instanceof HTMLElement)) throw new Error('缺少工作区')
  return node
}

test('折叠把侧栏宽度收到 0，动画结束前仍保留导航', () => {
  render(<Panes />)
  expect(shell().style.getPropertyValue('--workspace-sidebar-width')).toBe('256px')
  fireEvent.click(screen.getByRole('button', { name: '切换侧栏' }))
  expect(shell().style.getPropertyValue('--workspace-sidebar-width')).toBe('0px')
  expect(document.getElementById('workspace-sidebar')).not.toBeNull()
})

test('拖拽越界有阻尼，松手弹回上限', () => {
  const onSidebar = vi.fn()
  render(<Panes onSidebar={onSidebar} />)
  fireEvent.pointerDown(screen.getByRole('separator', { name: '调整侧边栏宽度' }), { button: 0, clientX: 0 })
  fireEvent.pointerMove(window, { clientX: 300 })
  const dragged = Number.parseFloat(shell().style.getPropertyValue('--workspace-sidebar-width'))
  expect(dragged).toBeGreaterThan(420)
  expect(dragged).toBeLessThan(256 + 300)
  fireEvent.pointerUp(window)
  expect(onSidebar).toHaveBeenCalledWith(true, 420)
})

test('拖过收起阈值后松手关闭，并保留原来的宽度', () => {
  const onSidebar = vi.fn()
  render(<Panes onSidebar={onSidebar} />)
  fireEvent.pointerDown(screen.getByRole('separator', { name: '调整侧边栏宽度' }), { button: 0, clientX: 400 })
  fireEvent.pointerMove(window, { clientX: 400 - 220 })
  fireEvent.pointerUp(window)
  expect(onSidebar).toHaveBeenCalledWith(false, 256)
})

test('窄窗口展开一侧时收起另一侧，并保留原栏宽', () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(660)
  const onSidebar = vi.fn()
  render(<Panes onSidebar={onSidebar} />)
  fireEvent.click(screen.getByRole('button', { name: '展开右侧栏' }))
  expect(shell()).toHaveAttribute('data-pane-sidebar', 'closed')
  expect(shell()).toHaveAttribute('data-pane-right', 'open')
  expect(onSidebar).toHaveBeenLastCalledWith(false, 256)

  fireEvent.click(screen.getByRole('button', { name: '切换侧栏' }))
  expect(shell()).toHaveAttribute('data-pane-sidebar', 'open')
  expect(shell()).toHaveAttribute('data-pane-right', 'closed')
  expect(onSidebar).toHaveBeenLastCalledWith(true, 256)
})

test.each([1280, 1024, 800])('容器宽 %d 时旧版加宽状态按保存宽度恢复，并为聊天保留至少 480px', (width) => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(width)
  window.localStorage.setItem(
    panelStorageKey('host', 'chat'),
    JSON.stringify({ ...defaultPanelLayout(), width: 360, expanded: true }),
  )
  render(<Panes />)
  fireEvent.click(screen.getByRole('button', { name: '展开右侧栏' }))
  const leftWidth = Number.parseFloat(shell().style.getPropertyValue('--workspace-sidebar-width'))
  const rightWidth = Number.parseFloat(shell().style.getPropertyValue('--workspace-right-width'))
  expect(rightWidth).toBe(Math.min(360, width - leftWidth - 480))
  expect(width - leftWidth - rightWidth).toBeGreaterThanOrEqual(480)
})

test('打开工具后仍可新增其他工具标签，并保留已有工具', () => {
  const panels: UiPanel[] = ['文件', '终端'].map((title) => ({
    id: `example:${title}`,
    title,
    icon: null,
    location: 'right',
    scope: 'app',
    render: () => `${title}正文`,
  }))
  render(<Panes panels={panels} />)
  fireEvent.click(screen.getByRole('button', { name: '展开右侧栏' }))
  fireEvent.click(screen.getByRole('button', { name: '文件' }))
  fireEvent.click(screen.getByRole('button', { name: '新标签页' }))
  fireEvent.click(screen.getByRole('button', { name: '终端' }))
  expect(screen.getByRole('tab', { name: '文件' })).toBeInTheDocument()
  expect(screen.getByRole('tab', { name: '终端' })).toHaveAttribute('aria-selected', 'true')
  fireEvent.click(screen.getByRole('tab', { name: '文件' }))
  expect(screen.getByRole('tabpanel', { name: '文件' })).toHaveTextContent('文件正文')
})

test('新会话与扩展中心分别调用对应操作', () => {
  const onNewSession = vi.fn()
  const onPlugins = vi.fn()
  render(<Panes onNewSession={onNewSession} onPlugins={onPlugins} />)
  fireEvent.click(screen.getByRole('button', { name: '展开右侧栏' }))
  fireEvent.click(screen.getByRole('button', { name: '新会话' }))
  expect(onNewSession).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: '扩展中心' }))
  expect(onPlugins).toHaveBeenCalledOnce()
})

test('键盘开合右侧栏后保留顶栏开关焦点', async () => {
  const user = userEvent.setup()
  render(<Panes />)
  const toggle = screen.getByRole('button', { name: '展开右侧栏' })
  toggle.focus()
  await user.keyboard('{Enter}')
  expect(screen.getByRole('button', { name: '收起右侧栏' })).toBe(toggle)
  expect(toggle).toHaveFocus()
  expect(toggle).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getAllByRole('button', { name: '收起右侧栏' })).toHaveLength(1)
  expect(toggle.closest('.workspace-topbar')).not.toBeNull()

  await user.keyboard('{Enter}')
  expect(screen.getByRole('button', { name: '展开右侧栏' })).toBe(toggle)
  expect(toggle).toHaveFocus()
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
})

const activityPanels: UiPanel[] = [
  {
    id: 'builtin:activities',
    title: '活动',
    icon: null,
    location: 'right',
    scope: 'app',
    render: () => '活动服务结果',
  },
]

test('活动入口按运行数显示且不自动打开，最后结束保留已开标签，关闭后不再出现', () => {
  const view = render(<Panes panels={activityPanels} activity={{ count: 0, known: true }} />)
  expect(shell()).toHaveAttribute('data-pane-right', 'closed')
  view.rerender(<Panes panels={activityPanels} activity={{ count: 1, known: true }} />)
  expect(shell()).toHaveAttribute('data-pane-right', 'closed')
  expect(screen.getByLabelText('1 个活动服务')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '展开右侧栏' }))
  fireEvent.click(screen.getByRole('button', { name: '活动' }))
  view.rerender(<Panes panels={activityPanels} activity={{ count: 0, known: true }} />)
  expect(screen.getByRole('tab', { name: '活动' })).toBeInTheDocument()
  expect(screen.getByRole('tabpanel')).toHaveTextContent('活动服务结果')
  fireEvent.click(screen.getByRole('button', { name: '新标签页' }))
  expect(screen.queryByRole('button', { name: '活动' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '关闭标签页：活动' }))
  expect(screen.queryByRole('tab', { name: '活动' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '活动' })).not.toBeInTheDocument()
})

test('切换会话与刷新不会恢复空活动标签，读取未知时不误删原活动标签', () => {
  const view = render(<Panes panels={activityPanels} activity={{ count: 1, known: true }} />)
  fireEvent.click(screen.getByRole('button', { name: '展开右侧栏' }))
  fireEvent.click(screen.getByRole('button', { name: '活动' }))
  view.rerender(<Panes session="other" panels={activityPanels} activity={{ count: 0, known: false }} />)
  expect(screen.getByRole('tab', { name: '活动' })).toBeInTheDocument()
  view.rerender(<Panes session="other" panels={activityPanels} activity={{ count: 0, known: true }} />)
  expect(screen.queryByRole('tab', { name: '活动' })).not.toBeInTheDocument()
  view.rerender(<Panes panels={activityPanels} activity={{ count: 0, known: true }} />)
  expect(screen.queryByRole('tab', { name: '活动' })).not.toBeInTheDocument()
  view.unmount()
  render(<Panes panels={activityPanels} activity={{ count: 0, known: true }} />)
  expect(screen.queryByRole('tab', { name: '活动' })).not.toBeInTheDocument()
})

test('折叠后悬停首页展开圆角会话浮层，移出后关闭', async () => {
  vi.useFakeTimers()
  try {
    render(<Panes />)
    fireEvent.click(screen.getByRole('button', { name: '切换侧栏' }))
    act(() => vi.advanceTimersByTime(400))
    const home = screen.getByRole('button', { name: '首页' })
    expect(document.getElementById('workspace-sidebar-flyout')).toBeNull()

    fireEvent.pointerEnter(home)
    act(() => vi.advanceTimersByTime(200))
    const flyout = document.getElementById('workspace-sidebar-flyout')
    expect(flyout).not.toBeNull()
    expect(flyout).toHaveTextContent('会话列表')
    // 四边同距贴在聊天框体内侧，顶边和底边留白一致。
    expect(flyout?.className).toContain('inset-2')
    expect(flyout?.className).toContain('rounded-xl')
    expect(flyout?.parentElement?.className).toContain('content-frame')
    expect(home).toHaveAttribute('aria-expanded', 'true')

    // 从首页移入浮层继续可用，移出后才收起。
    fireEvent.pointerMove(flyout!)
    act(() => vi.advanceTimersByTime(400))
    expect(document.getElementById('workspace-sidebar-flyout')).not.toBeNull()

    fireEvent.pointerMove(document.body)
    act(() => vi.advanceTimersByTime(250))
    // 关闭时先播退场动画，元素还在，但已经不可交互。
    const closing = document.getElementById('workspace-sidebar-flyout')
    expect(closing).not.toBeNull()
    expect(closing).toHaveAttribute('data-state', 'closed')
    expect(closing?.className).toContain('data-[state=closed]:animate-out')
    expect(home).toHaveAttribute('aria-expanded', 'false')

    act(() => vi.advanceTimersByTime(200))
    expect(document.getElementById('workspace-sidebar-flyout')).toBeNull()
  } finally {
    vi.useRealTimers()
  }
})

test('侧栏展开时不出现悬停浮层，Escape 关闭浮层并交还首页焦点', async () => {
  vi.useFakeTimers()
  try {
    render(<Panes />)
    const home = screen.getByRole('button', { name: '首页' })
    fireEvent.pointerEnter(home)
    act(() => vi.advanceTimersByTime(200))
    expect(document.getElementById('workspace-sidebar-flyout')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '切换侧栏' }))
    act(() => vi.advanceTimersByTime(400))
    fireEvent.pointerEnter(home)
    act(() => vi.advanceTimersByTime(200))
    expect(document.getElementById('workspace-sidebar-flyout')).not.toBeNull()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.getElementById('workspace-sidebar-flyout')).toHaveAttribute('data-state', 'closed')
    expect(home).toHaveFocus()
    act(() => vi.advanceTimersByTime(200))
    expect(document.getElementById('workspace-sidebar-flyout')).toBeNull()
  } finally {
    vi.useRealTimers()
  }
})

test('浮层内按 Escape 关闭并交还首页焦点，输入框内不抢 Escape', () => {
  vi.useFakeTimers()
  try {
    render(
      <TooltipProvider>
        <WorkspacePanels
          profile={DEFAULT_PROFILE}
          profileLoading={false}
          panels={[]}
          props={{ host: {} as HostApi, target: { hostId: 'host' }, snapshot: null }}
          session="chat"
          sidebar={<button type="button">会话列表</button>}
          sidebarOpen={false}
          sidebarWidth={256}
          onSidebar={() => {}}
          header={() => null}
        >
          <input aria-label="输入框" />
        </WorkspacePanels>
      </TooltipProvider>,
    )
    const home = screen.getByRole('button', { name: '首页' })
    fireEvent.keyDown(home, { key: 'ArrowRight' })
    const flyout = document.getElementById('workspace-sidebar-flyout')
    expect(flyout).not.toBeNull()
    expect(screen.getByRole('button', { name: '会话列表' })).toHaveFocus()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.getElementById('workspace-sidebar-flyout')).toHaveAttribute('data-state', 'closed')
    expect(home).toHaveFocus()
    act(() => vi.advanceTimersByTime(200))
    expect(document.getElementById('workspace-sidebar-flyout')).toBeNull()

    fireEvent.keyDown(home, { key: 'ArrowRight' })
    expect(document.getElementById('workspace-sidebar-flyout')).not.toBeNull()
    screen.getByRole('textbox', { name: '输入框' }).focus()
    fireEvent.keyDown(screen.getByRole('textbox', { name: '输入框' }), { key: 'Escape' })
    expect(document.getElementById('workspace-sidebar-flyout')).not.toBeNull()
  } finally {
    vi.useRealTimers()
  }
})

test('完整视图保留聊天草稿、滚动位置和当前工具实例，退出恢复分栏宽度', () => {
  const mounted = vi.fn()
  const unmounted = vi.fn()
  function Tool() {
    useEffect(() => {
      mounted()
      return unmounted
    }, [])
    return <textarea aria-label="工具草稿" defaultValue="工具内容" />
  }
  const panels: UiPanel[] = [
    { id: 'example:file', title: '文件', location: 'right', scope: 'app', icon: null, render: () => <Tool /> },
  ]
  render(
    <Panes panels={panels}>
      <textarea aria-label="聊天草稿" defaultValue="未发送的文字" />
    </Panes>,
  )
  const chat = screen.getByRole('textbox', { name: '聊天草稿' })
  const chatPane = document.getElementById('chat-workspace')!
  chatPane.scrollTop = 120
  fireEvent.click(screen.getByRole('button', { name: '展开右侧栏' }))
  fireEvent.click(screen.getByRole('button', { name: '文件' }))
  const tool = screen.getByRole('textbox', { name: '工具草稿' })
  fireEvent.change(tool, { target: { value: '未保存修改' } })
  const width = shell().style.getPropertyValue('--workspace-right-width')
  fireEvent.click(screen.getByRole('button', { name: '进入完整视图' }))
  expect(screen.getByRole('tab', { name: '聊天' })).toHaveAttribute('aria-selected', 'true')
  expect(chat).toBeVisible()
  expect(tool).not.toBeVisible()
  fireEvent.click(screen.getByRole('tab', { name: '文件' }))
  expect(chat).not.toBeVisible()
  expect(tool).toBeVisible()
  expect(tool).toHaveValue('未保存修改')
  expect(mounted).toHaveBeenCalledOnce()
  expect(unmounted).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '退出完整视图' }))
  expect(shell()).toHaveAttribute('data-view', 'split')
  expect(shell().style.getPropertyValue('--workspace-right-width')).toBe(width)
  expect(chat).toHaveValue('未发送的文字')
  expect(chatPane.scrollTop).toBe(120)
  expect(mounted).toHaveBeenCalledOnce()
  expect(unmounted).not.toHaveBeenCalled()
})

test('完整视图支持工具去重、键盘切换、关闭最后工具回聊天与刷新恢复模式', () => {
  const panels: UiPanel[] = [
    { id: 'example:file', title: '文件', location: 'right', scope: 'app', icon: null, render: () => '文件正文' },
  ]
  const view = render(<Panes panels={panels} />)
  fireEvent.click(screen.getByRole('button', { name: '进入完整视图' }))
  fireEvent.click(screen.getByRole('button', { name: '新标签页' }))
  fireEvent.click(screen.getByRole('button', { name: '文件' }))
  fireEvent.click(screen.getByRole('button', { name: '新标签页' }))
  fireEvent.click(screen.getByRole('button', { name: '文件' }))
  expect(screen.getAllByRole('tab', { name: '文件' })).toHaveLength(1)
  fireEvent.keyDown(screen.getByRole('tab', { name: '文件' }), { key: 'Home' })
  expect(screen.getByRole('tab', { name: '聊天' })).toHaveFocus()
  fireEvent.keyDown(screen.getByRole('tab', { name: '聊天' }), { key: 'End' })
  expect(screen.getByRole('tab', { name: '新标签页' })).toHaveFocus()
  fireEvent.click(screen.getByRole('button', { name: '关闭标签页：新标签页' }))
  fireEvent.click(screen.getByRole('button', { name: '关闭标签页：文件' }))
  expect(screen.getAllByRole('tab')).toHaveLength(1)
  expect(screen.getByRole('tab', { name: '聊天' })).toHaveAttribute('aria-selected', 'true')
  expect(screen.getByText('聊天正文')).toBeVisible()
  expect(window.localStorage.getItem('pi-meme:workspace-view:v1')).toBe('unified')
  view.unmount()
  render(<Panes panels={panels} />)
  expect(shell()).toHaveAttribute('data-view', 'unified')
  expect(screen.getByRole('tab', { name: '聊天' })).toHaveAttribute('aria-selected', 'true')
  expect(screen.getAllByRole('tab')).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: '新标签页' }))
  expect(screen.getByRole('tab', { name: '新标签页' })).toHaveAttribute('aria-selected', 'true')
  fireEvent.click(screen.getByRole('button', { name: '关闭标签页：新标签页' }))
  expect(screen.getAllByRole('tab')).toHaveLength(1)
  expect(screen.getByText('聊天正文')).toBeVisible()
})

test('完整视图在窄窗口独立展开左栏，切换会话回到聊天，工具失效安全回退', () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(660)
  const panels: UiPanel[] = [
    { id: 'example:file', title: '文件', location: 'right', scope: 'app', icon: null, render: () => '文件正文' },
  ]
  const view = render(<Panes panels={panels} />)
  fireEvent.click(screen.getByRole('button', { name: '进入完整视图' }))
  fireEvent.click(screen.getByRole('button', { name: '新标签页' }))
  fireEvent.click(screen.getByRole('button', { name: '文件' }))
  expect(shell()).toHaveAttribute('data-pane-sidebar', 'open')
  view.rerender(<Panes panels={panels} session="other" />)
  expect(screen.getByRole('tab', { name: '聊天' })).toHaveAttribute('aria-selected', 'true')
  fireEvent.click(screen.getByRole('tab', { name: '文件' }))
  view.rerender(<Panes panels={[]} session="other" />)
  expect(screen.getByRole('tab', { name: '聊天' })).toHaveAttribute('aria-selected', 'true')
  expect(screen.getByText('聊天正文')).toBeVisible()
})

test('从聊天退出完整视图恢复原关闭状态，分栏按钮显式展开工具', () => {
  render(<Panes />)
  fireEvent.click(screen.getByRole('button', { name: '进入完整视图' }))
  fireEvent.click(screen.getByRole('button', { name: '退出完整视图' }))
  expect(shell()).toHaveAttribute('data-pane-right', 'closed')
  fireEvent.click(screen.getByRole('button', { name: '进入完整视图' }))
  fireEvent.click(screen.getByRole('button', { name: '分栏显示工具' }))
  expect(shell()).toHaveAttribute('data-view', 'split')
  expect(shell()).toHaveAttribute('data-pane-right', 'open')
})

test('完整视图快捷键切换模式，聚焦输入框快捷键先恢复聊天', async () => {
  const focus = vi.fn()
  render(
    <ShortcutProvider>
      <Panes onFocusComposer={focus} />
    </ShortcutProvider>,
  )
  const mod = { metaKey: detectPlatform() === 'darwin', ctrlKey: detectPlatform() !== 'darwin' }
  fireEvent.keyDown(document.body, { key: 'F', code: 'KeyF', shiftKey: true, ...mod })
  expect(shell()).toHaveAttribute('data-view', 'unified')
  fireEvent.click(screen.getByRole('button', { name: '新标签页' }))
  expect(screen.getByRole('tab', { name: '新标签页' })).toHaveAttribute('aria-selected', 'true')
  fireEvent.keyDown(document.body, { key: 'L', code: 'KeyL', shiftKey: true, ...mod })
  expect(screen.getByRole('tab', { name: '聊天' })).toHaveAttribute('aria-selected', 'true')
  await act(async () => {
    await new Promise(requestAnimationFrame)
  })
  expect(focus).toHaveBeenCalledOnce()
})

test('布局存储损坏或被禁用时仍可切换模式', () => {
  window.localStorage.setItem('pi-meme:workspace-view:v1', 'broken')
  const view = render(<Panes />)
  expect(shell()).toHaveAttribute('data-view', 'split')
  view.unmount()
  const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('存储被禁用')
  })
  const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('存储被禁用')
  })
  try {
    render(<Panes />)
    fireEvent.click(screen.getByRole('button', { name: '进入完整视图' }))
    expect(shell()).toHaveAttribute('data-view', 'unified')
  } finally {
    get.mockRestore()
    set.mockRestore()
  }
})
