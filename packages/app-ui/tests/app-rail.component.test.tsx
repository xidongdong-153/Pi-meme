import '@testing-library/jest-dom/vitest'
import { lazy, type ReactNode } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'
import { AppRail } from '../src/layout/app-rail'
import { PageHeader, PageHeaderNavigation } from '../src/layout/page-header'
import { SchedulesWorkspace } from '../src/layout/schedules-workspace'
import { DEFAULT_PROFILE } from '../src/settings/user-profile'

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

test('AppRail 顶部首页入口调用新聊天操作', () => {
  const onHome = vi.fn()
  renderRail({ onHome, homeActive: true })

  fireEvent.click(screen.getByRole('button', { name: '首页' }))
  expect(onHome).toHaveBeenCalledTimes(1)
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

test('AppRail 用户菜单顶部展示姓名且不含 Pro，点击触发个人资料回调', async () => {
  const onAccount = vi.fn()
  renderRail({ onAccount })

  const avatarBtn = screen.getByRole('button', { name: '用户菜单与设置' })
  openUserMenu(avatarBtn)

  const nameElement = await screen.findByText('meme 用户')
  expect(nameElement).toBeInTheDocument()
  expect(screen.queryByText('Pro')).not.toBeInTheDocument()

  fireEvent.click(nameElement)
  expect(onAccount).toHaveBeenCalledTimes(1)
})

test('AppRail 用户菜单「用量」项点击触发对应回调', async () => {
  const onUsage = vi.fn()
  renderRail({ onUsage })

  const avatarBtn = screen.getByRole('button', { name: '用户菜单与设置' })
  openUserMenu(avatarBtn)

  const usageItem = await screen.findByRole('menuitem', { name: /用量/ })
  expect(usageItem).toBeInTheDocument()
  fireEvent.click(usageItem)
  expect(onUsage).toHaveBeenCalledTimes(1)
})

test('AppRail 用户菜单「设置」项点击触发对应回调', async () => {
  const onSettings = vi.fn()
  renderRail({ onSettings })

  const avatarBtn = screen.getByRole('button', { name: '用户菜单与设置' })
  openUserMenu(avatarBtn)

  const settingsItem = await screen.findByRole('menuitem', { name: /设置/ })
  expect(settingsItem).toBeInTheDocument()
  fireEvent.click(settingsItem)
  expect(onSettings).toHaveBeenCalledTimes(1)
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
