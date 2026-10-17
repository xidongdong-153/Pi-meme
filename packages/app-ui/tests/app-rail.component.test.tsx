import '@testing-library/jest-dom/vitest'
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'
import { AppRail } from '../src/layout/app-rail'

afterEach(cleanup)

function renderRail(props: Partial<Parameters<typeof AppRail>[0]> = {}) {
  return render(
    <TooltipProvider>
      <AppRail {...props} />
    </TooltipProvider>,
  )
}

function openUserMenu(btn: HTMLElement) {
  fireEvent.pointerDown(btn, { button: 0, ctrlKey: false })
}

test('AppRail 渲染顶部切换按钮并响应点击', () => {
  const onToggleSidebar = vi.fn()
  renderRail({ onToggleSidebar })

  const toggleBtn = screen.getByRole('button', { name: '收起会话抽屉' })
  fireEvent.click(toggleBtn)
  expect(onToggleSidebar).toHaveBeenCalledTimes(1)
})

test('AppRail 用户菜单顶部展示姓名且不含 Pro，点击触发个人资料回调', async () => {
  const onAccount = vi.fn()
  renderRail({ onAccount })

  const avatarBtn = screen.getByRole('button', { name: '用户菜单与设置' })
  openUserMenu(avatarBtn)

  const nameElement = await screen.findByText('xi dongdong')
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

test('AppRail 帮助菜单项包含二级菜单触发项', async () => {
  renderRail()

  const avatarBtn = screen.getByRole('button', { name: '用户菜单与设置' })
  openUserMenu(avatarBtn)

  const helpItem = await screen.findByText('帮助')
  expect(helpItem).toBeInTheDocument()
})
