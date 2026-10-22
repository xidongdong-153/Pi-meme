import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'
import { detectPlatform, ShortcutProvider, useShortcutHandlers, useShortcuts } from '../src/shortcuts/shortcut-provider'
import { ShortcutHelpDialog } from '../src/shortcuts/shortcut-help-dialog'
import { ShortcutSettings } from '../src/shortcuts/shortcut-settings'
import { useState } from 'react'

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  vi.restoreAllMocks()
})

beforeEach(() => {
  window.localStorage.clear()
})

function TestConsumer({ onNewChat, shortcutEnabled = true }: { onNewChat?: () => void; shortcutEnabled?: boolean }) {
  const { getShortcutLabel } = useShortcuts()
  useShortcutHandlers(
    {
      newChat: onNewChat,
    },
    shortcutEnabled,
  )

  return (
    <div>
      <span data-testid="new-chat-label">{getShortcutLabel('newChat')}</span>
      <input data-testid="normal-input" />
      <div className="cm-editor" tabIndex={0} data-testid="code-editor">
        编辑器
      </div>
    </div>
  )
}

test('ShortcutProvider 正常响应按键分发，输入框和代码编辑器内不触发应用快捷键', async () => {
  const onNewChat = vi.fn()
  render(
    <TooltipProvider>
      <ShortcutProvider>
        <TestConsumer onNewChat={onNewChat} />
      </ShortcutProvider>
    </TooltipProvider>,
  )

  // Web 下 newChat 默认为 Mod+Alt+N
  const isMac = detectPlatform() === 'darwin'

  // 1. 在普通 DOM 上触发
  fireEvent.keyDown(document.body, {
    key: 'n',
    code: 'KeyN',
    metaKey: isMac,
    ctrlKey: !isMac,
    altKey: true,
  })
  expect(onNewChat).toHaveBeenCalledTimes(1)

  // 2. 在普通 input 输入框内触发，不应抢占
  const input = screen.getByTestId('normal-input')
  fireEvent.keyDown(input, {
    key: 'n',
    code: 'KeyN',
    metaKey: isMac,
    ctrlKey: !isMac,
    altKey: true,
  })
  expect(onNewChat).toHaveBeenCalledTimes(1)

  // 3. 在代码编辑器 .cm-editor 内触发，不应抢占
  const editor = screen.getByTestId('code-editor')
  fireEvent.keyDown(editor, {
    key: 'n',
    code: 'KeyN',
    metaKey: isMac,
    ctrlKey: !isMac,
    altKey: true,
  })
  expect(onNewChat).toHaveBeenCalledTimes(1)
})

test('ShortcutHelpDialog 正常打开、搜索并可触发跳转编辑', async () => {
  const onEdit = vi.fn()
  function Wrapper() {
    const [open, setOpen] = useState(true)
    return (
      <TooltipProvider>
        <ShortcutProvider>
          <ShortcutHelpDialog open={open} onOpenChange={setOpen} onEdit={onEdit} />
        </ShortcutProvider>
      </TooltipProvider>
    )
  }

  render(<Wrapper />)
  expect(screen.getByText('键盘快捷键')).toBeInTheDocument()
  expect(screen.getByText('新建聊天')).toBeInTheDocument()

  // 搜索
  const searchInput = screen.getByLabelText('搜索快捷键')
  fireEvent.change(searchInput, { target: { value: '终端' } })
  expect(screen.getByText('打开终端面板')).toBeInTheDocument()
  expect(screen.queryByText('新建聊天')).not.toBeInTheDocument()

  // 点击编辑快捷键
  fireEvent.click(screen.getByRole('button', { name: /编辑快捷键/ }))
  await waitFor(() => expect(onEdit).toHaveBeenCalledTimes(1))
})

test('ShortcutSettings 支持修改、冲突拦截、取消与恢复默认', async () => {
  render(
    <TooltipProvider>
      <ShortcutProvider>
        <ShortcutSettings />
      </ShortcutProvider>
    </TooltipProvider>,
  )

  expect(screen.getByText('恢复全部默认')).toBeDisabled()

  // 1. 点击录入新聊天
  const changeBtn = screen.getByLabelText('修改快捷键：新建聊天')
  fireEvent.click(changeBtn)
  expect(screen.getByText('请按下快捷键')).toBeInTheDocument()

  // 2. 模拟冲突按键：比如按下搜索会话的默认快捷键 (Mod+K)
  const isMac = detectPlatform() === 'darwin'
  fireEvent.keyDown(changeBtn, {
    key: 'k',
    code: 'KeyK',
    metaKey: isMac,
    ctrlKey: !isMac,
  })
  expect(screen.getByRole('alert')).toHaveTextContent(/已用于：搜索会话/)

  // 3. 按下不冲突的合法快捷键 (Mod+Shift+D)
  fireEvent.keyDown(changeBtn, {
    key: 'd',
    code: 'KeyD',
    metaKey: isMac,
    ctrlKey: !isMac,
    shiftKey: true,
  })

  // 录入成功，行内错误消失，出现已自定义标记（恢复默认按钮可用）
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  const resetBtn = screen.getByLabelText('恢复默认：新建聊天')
  expect(resetBtn).not.toBeDisabled()

  // 4. 点击恢复默认
  fireEvent.click(resetBtn)
  await waitFor(() => expect(resetBtn).toBeDisabled())

  // 5. 点击取消绑定
  const unbindBtn = screen.getByLabelText('取消绑定：新建聊天')
  fireEvent.click(unbindBtn)
  await waitFor(() => expect(unbindBtn).toBeDisabled())
})
