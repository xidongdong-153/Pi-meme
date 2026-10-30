import '@testing-library/jest-dom/vitest'
import { lazy, type ReactNode } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'
import { AppRail } from '../src/layout/app-rail'
import { PageHeader, PageHeaderNavigation } from '../src/layout/page-header'
import { SchedulesWorkspace } from '../src/layout/schedules-workspace'
import { DEFAULT_PROFILE } from '../src/settings/user-profile'
import { ModelPickerPopover } from '@pi-meme/models/ui/model-picker-popover'

afterEach(cleanup)

function renderRail(props: Partial<Parameters<typeof AppRail>[0]> = {}) {
  return render(
    <TooltipProvider>
      <AppRail profile={DEFAULT_PROFILE} profileLoading={false} {...props} />
    </TooltipProvider>,
  )
}

function openUserMenu(btn: HTMLElement) {
  fireEvent.pointerDown(btn, { button: 0, ctrlKey: false })
}

test('模型弹框打开时点击用户菜单立即关闭弹框，并可直接进入设置', async () => {
  const onSettings = vi.fn()
  render(
    <TooltipProvider>
      <AppRail profile={DEFAULT_PROFILE} profileLoading={false} onSettings={onSettings} />
      <ModelPickerPopover models={[]} disabled={false} onSelectModel={vi.fn()} onSelectThinkingLevel={vi.fn()} />
    </TooltipProvider>,
  )
  fireEvent.click(screen.getByRole('button', { name: '选择模型与思考强度' }))
  expect(screen.getByRole('dialog')).toBeInTheDocument()
  openUserMenu(screen.getByRole('button', { name: '用户菜单与设置' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  fireEvent.click(await screen.findByRole('menuitem', { name: /设置/ }))
  expect(onSettings).toHaveBeenCalledOnce()
})

test.each(['设置', '用量', '个人资料'])('用户菜单选择%s时立即卸载，不在隐藏头像上播放退场动画', (destination) => {
  const getStyles = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudoElement) => {
    const styles = getStyles(element, pseudoElement)
    if (element.getAttribute('role') !== 'menu') return styles
    return new Proxy(styles, {
      get(target, property) {
        if (property === 'animationName') return element.getAttribute('data-state') === 'open' ? 'enter' : 'exit'
        if (property === 'display') return 'block'
        return Reflect.get(target, property)
      },
    })
  })
  const navigate = vi.fn()
  renderRail({ onSettings: navigate, onUsage: navigate, onAccount: navigate })
  const avatar = screen.getByRole('button', { name: '用户菜单与设置' })
  openUserMenu(avatar)
  const menu = screen.getByRole('menu')
  fireEvent.click(
    destination === '个人资料'
      ? screen.getByRole('button', { name: /meme 用户/ })
      : screen.getByRole('menuitem', { name: new RegExp(destination) }),
  )
  expect(navigate).toHaveBeenCalledOnce()
  expect(menu.isConnected).toBe(false)
  expect(document.querySelector('[data-radix-popper-content-wrapper]')).toBeNull()
  expect(avatar).toHaveAttribute('aria-expanded', 'false')
  openUserMenu(avatar)
  expect(screen.getByRole('menu')).toBeInTheDocument()
})

test.each(['外部点击', 'Escape'])('头像菜单通过%s关闭后恢复焦点，不自动弹出提示', async (method) => {
  renderRail()
  const avatar = screen.getByRole('button', { name: '用户菜单与设置' })
  openUserMenu(avatar)
  await screen.findByRole('menu')
  // 等待 Radix 注册外部指针事件，再模拟鼠标抬起后的关闭操作。
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  fireEvent.pointerUp(avatar)
  if (method === '外部点击') {
    fireEvent.pointerDown(document.body, { button: 0, pointerType: 'mouse' })
    fireEvent.pointerUp(document.body)
    fireEvent.click(document.body)
  } else {
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  }
  await waitFor(() => expect(avatar).toHaveFocus())
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

  act(() => avatar.blur())
  act(() => avatar.focus())
  expect(await screen.findByRole('tooltip')).toHaveTextContent('设置与账户')
})

test('定时任务首次加载时保留可交互的顶栏和导航栏', async () => {
  let resolveContent!: (module: { default: () => ReactNode }) => void
  const Content = lazy(
    () =>
      new Promise<{ default: () => ReactNode }>((resolve) => {
        resolveContent = resolve
      }),
  )
  const onHome = vi.fn()
  const onBack = vi.fn()
  render(
    <TooltipProvider>
      <SchedulesWorkspace
        header={
          <PageHeader>
            <PageHeaderNavigation nativeWindow={false} back={{ label: '返回上一页', onClick: onBack }} />
          </PageHeader>
        }
        rail={<AppRail profile={DEFAULT_PROFILE} profileLoading={false} schedulesActive onHome={onHome} />}
      >
        <Content />
      </SchedulesWorkspace>
    </TooltipProvider>,
  )

  const back = screen.getByRole('button', { name: '返回上一页' })
  const home = screen.getByRole('button', { name: '首页' })
  const schedules = screen.getByRole('button', { name: '定时任务' })
  const frame = screen.getByRole('status').closest('.content-frame')
  expect(frame).not.toBeNull()
  expect(schedules).toHaveAttribute('aria-current', 'page')
  fireEvent.click(back)
  fireEvent.click(home)
  expect(onBack).toHaveBeenCalledOnce()
  expect(onHome).toHaveBeenCalledOnce()

  await act(async () => resolveContent({ default: () => <div className="content-frame">定时任务内容</div> }))
  expect(screen.getByRole('button', { name: '返回上一页' })).toBe(back)
  expect(screen.getByRole('button', { name: '首页' })).toBe(home)
  expect(screen.getByRole('button', { name: '定时任务' })).toBe(schedules)
  expect(screen.getByText('定时任务内容')).toHaveClass('content-frame')
  expect(screen.queryByRole('status')).toBeNull()
})

test('AppRail 帮助菜单项包含二级菜单触发项，点击键盘快捷键触发回调', async () => {
  const onShortcutHelp = vi.fn()
  renderRail({ onShortcutHelp })

  const avatarBtn = screen.getByRole('button', { name: '用户菜单与设置' })
  openUserMenu(avatarBtn)

  const helpItem = await screen.findByText('帮助')
  const helpTrigger = helpItem.closest('[role="menuitem"]') ?? helpItem
  expect(helpTrigger).toBeInTheDocument()
  fireEvent.keyDown(helpTrigger, { key: 'ArrowRight' })

  const shortcutItem = await screen.findByRole('menuitem', { name: /键盘快捷键/ })
  expect(shortcutItem).toBeInTheDocument()
  fireEvent.click(shortcutItem)
  expect(onShortcutHelp).toHaveBeenCalledTimes(1)
})
