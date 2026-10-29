import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'
import type { UiContributionProps, UiPanel } from '@pi-meme/plugin-sdk/ui'
import { DEFAULT_PROFILE } from '../src/settings/user-profile'
import { WorkspacePanels } from '../src/layout/workspace-panels'
import { sideChatTabId, toolsTabId } from '../src/layout/panel-layout'

const originalScrollIntoView = Element.prototype.scrollIntoView

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
  vi.stubGlobal(
    'requestAnimationFrame',
    (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0) as unknown as number,
  )
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>))
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  Element.prototype.scrollIntoView = originalScrollIntoView
})

const mockHost = {} as import('@pi-meme/contracts/app-host').HostApi
const defaultProps: UiContributionProps = {
  host: mockHost,
  target: { hostId: 'test-host' },
  snapshot: null,
}

const mockFilesPanel: UiPanel = {
  id: 'builtin:files',
  title: '文件',
  icon: null,
  location: 'right',
  scope: 'app',
  render: () => <div data-testid="files-panel">文件列表</div>,
}

const mockTerminalPanel: UiPanel = {
  id: 'builtin:terminal',
  title: '终端',
  icon: null,
  location: 'right',
  scope: 'app',
  render: () => <div data-testid="terminal-panel">终端控制台</div>,
}

describe('WorkspacePanels 异步关闭与侧边聊天交互', () => {
  it('文件引用只打开独立标签，不出现在新标签页的工具列表', () => {
    const filePanel: UiPanel = {
      ...mockFilesPanel,
      id: 'builtin:file:entry',
      title: 'entry.ts',
      render: () => <div>代码预览</div>,
    }
    render(
      <TooltipProvider>
        <WorkspacePanels
          profile={DEFAULT_PROFILE}
          profileLoading={false}
          props={defaultProps}
          session="session-a"
          sidebar="侧栏"
          sidebarOpen={false}
          sidebarWidth={256}
          onSidebar={() => {}}
          header={(_toggle, tabs) => tabs?.()}
          panels={[mockFilesPanel, filePanel]}
          requestPanel={{ id: filePanel.id, revision: 1, target: defaultProps.target }}
        >
          <div>主聊天正文</div>
        </WorkspacePanels>
      </TooltipProvider>,
    )
    expect(screen.getByRole('tab', { name: 'entry.ts' })).toBeInTheDocument()
    expect(screen.getByText('代码预览')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '新标签页' }))
    expect(screen.queryByRole('button', { name: 'entry.ts' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '文件' })).toBeInTheDocument()
  })
  it('收起右侧栏或切换到其他工具不会关闭侧边聊天', async () => {
    const onClose = vi.fn()
    function TestWrapper() {
      const [sidebarOpen, setSidebarOpen] = useState(true)
      return (
        <TooltipProvider>
          <WorkspacePanels
            profile={DEFAULT_PROFILE}
            profileLoading={false}
            props={defaultProps}
            session="session-a"
            sidebar="侧栏"
            sidebarOpen={sidebarOpen}
            sidebarWidth={256}
            onSidebar={(open) => setSidebarOpen(open)}
            header={() => <div>顶栏</div>}
            panels={[mockFilesPanel]}
            sideChatActive={true}
            sideChat={<div data-testid="side-chat-body">侧边聊天正文</div>}
            onClosePanel={onClose}
          >
            <div>主聊天正文</div>
          </WorkspacePanels>
        </TooltipProvider>
      )
    }

    render(<TestWrapper />)
    expect(screen.getByRole('tab', { name: '侧边聊天' })).toBeInTheDocument()
    expect(screen.getByTestId('side-chat-body')).toBeInTheDocument()

    // 1. 打开新标签页并选择“文件”，使其进入 tabs
    fireEvent.click(screen.getByRole('button', { name: '新标签页' }))
    fireEvent.click(screen.getByRole('button', { name: /文件/ }))
    expect(screen.getByRole('tab', { name: '文件' })).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()

    // 2. 在“文件”和“侧边聊天”之间切换
    fireEvent.click(screen.getByRole('tab', { name: '侧边聊天' }))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('tab', { name: '侧边聊天' })).toBeInTheDocument()

    // 3. 点击收起右侧栏
    const collapseButton = screen.getByRole('button', { name: /收起右侧栏/ })
    fireEvent.click(collapseButton)
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('tab', { name: '侧边聊天' })).toBeInTheDocument()
  })

  it('关闭失败时保留标签且可重试，成功才移除标签', async () => {
    let shouldFail = true
    const onClose = vi.fn(async () => {
      if (shouldFail) return false
      return true
    })

    function TestWrapper() {
      return (
        <TooltipProvider>
          <WorkspacePanels
            profile={DEFAULT_PROFILE}
            profileLoading={false}
            props={defaultProps}
            session="session-a"
            sidebar="侧栏"
            sidebarOpen={true}
            sidebarWidth={256}
            onSidebar={() => {}}
            header={() => null}
            panels={[mockFilesPanel]}
            sideChatActive={true}
            sideChat={<div>侧边聊天</div>}
            onClosePanel={onClose}
          >
            <div>主聊天</div>
          </WorkspacePanels>
        </TooltipProvider>
      )
    }

    render(<TestWrapper />)
    const closeBtn = screen.getByRole('button', { name: '关闭标签页：侧边聊天' })

    // 第一次尝试关闭：失败
    await act(async () => {
      fireEvent.click(closeBtn)
    })
    expect(onClose).toHaveBeenCalledTimes(1)
    // 失败保留标签
    expect(screen.getByRole('tab', { name: '侧边聊天' })).toBeInTheDocument()

    // 第二次尝试关闭：成功
    shouldFail = false
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '关闭标签页：侧边聊天' }))
    })
    expect(onClose).toHaveBeenCalledTimes(2)
    // 成功后移除标签
    expect(screen.queryByRole('tab', { name: '侧边聊天' })).toBeNull()
  })

  it('关闭 pending 期间切换主会话不覆盖新会话布局，也不复活标签', async () => {
    let resolveClose!: (value: boolean) => void
    const closePromise = new Promise<boolean>((resolve) => {
      resolveClose = resolve
    })
    const onClose = vi.fn(() => closePromise)

    function TestWrapper() {
      const [session, setSession] = useState('session-1')
      return (
        <TooltipProvider>
          <div>
            <button type="button" onClick={() => setSession('session-2')}>
              切换到会话2
            </button>
            <WorkspacePanels
              profile={DEFAULT_PROFILE}
              profileLoading={false}
              props={defaultProps}
              session={session}
              sidebar="侧栏"
              sidebarOpen={true}
              sidebarWidth={256}
              onSidebar={() => {}}
              header={() => null}
              panels={[mockFilesPanel, mockTerminalPanel]}
              sideChatActive={true}
              sideChat={<div>侧边聊天</div>}
              onClosePanel={onClose}
            >
              <div>主聊天</div>
            </WorkspacePanels>
          </div>
        </TooltipProvider>
      )
    }

    render(<TestWrapper />)
    expect(screen.getByRole('tab', { name: '侧边聊天' })).toBeInTheDocument()

    // 1. 点击关闭侧边聊天，进入 pending
    fireEvent.click(screen.getByRole('button', { name: '关闭标签页：侧边聊天' }))
    expect(onClose).toHaveBeenCalledWith(sideChatTabId)

    // 2. 在关闭 pending 期间，切换主会话
    act(() => {
      fireEvent.click(screen.getByText('切换到会话2'))
    })

    // 3. 完成关闭
    await act(async () => {
      resolveClose(true)
    })

    // 验证：侧边聊天标签已移除，新会话的上下文依然正常，不报错也不复活已关闭的标签
    expect(screen.queryByRole('tab', { name: '侧边聊天' })).toBeNull()
  })

  it('关闭 pending 期间打开其他工具，关闭完成时不覆盖新打开的标签', async () => {
    let resolveClose!: (value: boolean) => void
    const closePromise = new Promise<boolean>((resolve) => {
      resolveClose = resolve
    })
    const onClose = vi.fn(() => closePromise)

    function TestWrapper() {
      return (
        <TooltipProvider>
          <WorkspacePanels
            profile={DEFAULT_PROFILE}
            profileLoading={false}
            props={defaultProps}
            session="session-tools"
            sidebar="侧栏"
            sidebarOpen={true}
            sidebarWidth={256}
            onSidebar={() => {}}
            header={() => null}
            panels={[mockFilesPanel, mockTerminalPanel]}
            sideChatActive={true}
            sideChat={<div>侧边聊天</div>}
            onClosePanel={onClose}
          >
            <div>主聊天</div>
          </WorkspacePanels>
        </TooltipProvider>
      )
    }

    render(<TestWrapper />)
    expect(screen.getByRole('tab', { name: '侧边聊天' })).toBeInTheDocument()

    // 1. 发起关闭侧边聊天
    fireEvent.click(screen.getByRole('button', { name: '关闭标签页：侧边聊天' }))

    // 2. 在 pending 期间点击打开新标签页并选择“终端”
    fireEvent.click(screen.getByRole('button', { name: '新标签页' }))
    expect(screen.getByRole('button', { name: /终端/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /终端/ }))
    expect(screen.getByRole('tab', { name: '终端' })).toBeInTheDocument()

    // 3. 完成关闭
    await act(async () => {
      resolveClose(true)
    })

    // 验证：侧边聊天已关闭，新打开的终端标签依然完好存在！
    expect(screen.queryByRole('tab', { name: '侧边聊天' })).toBeNull()
    expect(screen.getByRole('tab', { name: '终端' })).toBeInTheDocument()
  })

  it('新标签页中搜索能够过滤侧边聊天，推荐区域不重复展示侧边聊天', () => {
    function TestWrapper() {
      return (
        <TooltipProvider>
          <WorkspacePanels
            profile={DEFAULT_PROFILE}
            profileLoading={false}
            props={defaultProps}
            session="session-search"
            sidebar="侧栏"
            sidebarOpen={true}
            sidebarWidth={256}
            onSidebar={() => {}}
            header={() => null}
            panels={[mockFilesPanel]}
            sideChatActive={false}
            requestRight={toolsTabId}
          >
            <div>主聊天</div>
          </WorkspacePanels>
        </TooltipProvider>
      )
    }

    render(<TestWrapper />)
    // 展开右侧栏进入工具选择页
    fireEvent.click(screen.getByRole('button', { name: '展开右侧栏' }))

    // 1. 验证工具列表中有且仅有一个常驻“侧边聊天”入口，且推荐区没有重复的“侧边聊天”
    const sideChatButtons = screen.getAllByRole('button', { name: '侧边聊天' })
    expect(sideChatButtons).toHaveLength(1)

    // 验证推荐区包含“新会话”和“扩展中心”
    expect(screen.getByRole('button', { name: '新会话' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '扩展中心' })).toBeInTheDocument()

    // 2. 搜索框搜索“侧边”，匹配展示
    const searchInput = screen.getByPlaceholderText('查找工具和插件')
    fireEvent.change(searchInput, { target: { value: '侧边' } })
    expect(screen.getByRole('button', { name: '侧边聊天' })).toBeInTheDocument()

    // 3. 搜索框搜索不匹配项“xyz”，侧边聊天被过滤隐藏
    fireEvent.change(searchInput, { target: { value: 'xyz' } })
    expect(screen.queryByRole('button', { name: '侧边聊天' })).toBeNull()
    expect(screen.getByText('没有匹配的工具。')).toBeInTheDocument()
  })

  it('统一视图(unified)下关闭唯一工具标签时，updater 纯粹更新且 toolActive 安全重置', async () => {
    window.localStorage.setItem('pi-meme:workspace-view:v1', 'unified')
    const onClose = vi.fn().mockResolvedValue(true)

    function TestWrapper() {
      return (
        <TooltipProvider>
          <WorkspacePanels
            profile={DEFAULT_PROFILE}
            profileLoading={false}
            props={defaultProps}
            session="session-unified"
            sidebar="侧栏"
            sidebarOpen={false}
            sidebarWidth={256}
            onSidebar={() => {}}
            header={() => <div>顶栏</div>}
            panels={[mockFilesPanel]}
            sideChatActive={true}
            sideChat={<div data-testid="side-chat-body">侧边聊天正文</div>}
            onClosePanel={onClose}
          >
            <div data-testid="main-chat-body">主聊天正文</div>
          </WorkspacePanels>
        </TooltipProvider>
      )
    }

    render(<TestWrapper />)
    // 初始展示主聊天，点击“分栏显示工具”切入工具视图
    expect(screen.getByTestId('main-chat-body')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '分栏显示工具' }))
    expect(screen.getByTestId('side-chat-body')).toBeInTheDocument()

    // 关闭侧边聊天标签
    const closeButton = screen.getByRole('button', { name: '关闭标签页：侧边聊天' })
    await act(async () => {
      fireEvent.click(closeButton)
    })

    // 关闭完成后，唯一工具标签移除，updater 纯粹计算使 toolActive 安全重置为 false，主聊天正文恢复可见
    expect(screen.queryByTestId('side-chat-body')).toBeNull()
    expect(screen.getByTestId('main-chat-body')).toBeInTheDocument()
  })
})
