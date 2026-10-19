import '@testing-library/jest-dom/vitest'
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render as renderUi, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { BentoSkeletonCard } from '@pi-meme/ui/components/bento-skeleton'
import { TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'
import { SettingsSkeleton } from '../src/settings/settings-skeleton'
import { SettingsPage } from '../src/settings/settings-page'

afterEach(cleanup)

function render(children: ReactNode) {
  return renderUi(<TooltipProvider>{children}</TooltipProvider>)
}

test('BentoSkeletonCard 渲染包含流光层与基础圆角样式', () => {
  render(
    <BentoSkeletonCard testId="bento-card" delay={100}>
      <p>Content</p>
    </BentoSkeletonCard>,
  )
  const card = screen.getByTestId('bento-card')
  expect(card).toBeInTheDocument()
  expect(card.className).toContain('rounded-2xl')
  expect(card.className).toContain('isolate')
  const shimmer = card.querySelector('.bento-shimmer')
  expect(shimmer).toBeInTheDocument()
  expect(shimmer).toHaveStyle({ animationDelay: '100ms' })
})

test('SettingsSkeleton 针对各个设置模块渲染对应的 Bento 骨架屏结构', () => {
  const sections = [
    { id: 'general', testId: 'settings-skeleton-general' },
    { id: 'account', testId: 'settings-skeleton-account' },
    { id: 'appearance', testId: 'settings-skeleton-appearance' },
    { id: 'profile', testId: 'settings-skeleton-profile' },
    { id: 'models', testId: 'settings-skeleton-models' },
    { id: 'instructions', testId: 'settings-skeleton-instructions' },
    { id: 'skills', testId: 'settings-skeleton-skills' },
    { id: 'plugins', testId: 'settings-skeleton-plugins' },
    { id: 'mcp', testId: 'settings-skeleton-mcp' },
    { id: 'host', testId: 'settings-skeleton-host' },
    { id: 'about', testId: 'settings-skeleton-about' },
  ] as const

  for (const { id, testId } of sections) {
    const { unmount } = render(<SettingsSkeleton section={id} />)
    expect(screen.getByTestId(testId)).toBeInTheDocument()
    unmount()
  }
})

test('插件入口直接打开插件分类，随后仍可切换其他设置', () => {
  render(
    <SettingsPage
      initialSection="plugins"
      renderContent={(section) => <p>{section}正文</p>}
      dirty={false}
      saving={false}
      onDiscard={() => {}}
      onDismiss={() => {}}
    />,
  )
  expect(screen.getByRole('button', { name: '插件' })).toHaveAttribute('aria-current', 'page')
  expect(screen.getByText('plugins正文')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '常规' }))
  expect(screen.getByText('general正文')).toBeInTheDocument()
})

test('SettingsPage 在异步挂起时渲染专属骨架屏，而非正在加载文本', () => {
  // 一个永久挂起的假组件
  function SuspendingComponent(): null {
    throw new Promise(() => {})
  }

  render(
    <SettingsPage
      renderContent={() => <SuspendingComponent />}
      dirty={false}
      saving={false}
      onDiscard={() => {}}
      onDismiss={() => {}}
    />,
  )

  // 默认 section 是 general，应展示 general 的骨架屏
  expect(screen.getByTestId('settings-skeleton-general')).toBeInTheDocument()
  // 确认不再有“正在加载设置…”这行纯文字
  expect(screen.queryByText('正在加载设置…')).toBeNull()
})

test('设置页通过共用顶栏返回聊天，进入时聚焦返回按钮', () => {
  const onDismiss = vi.fn()
  render(
    <SettingsPage
      renderContent={() => <p>设置正文</p>}
      dirty={false}
      saving={false}
      onDiscard={vi.fn()}
      onDismiss={onDismiss}
    />,
  )
  const back = screen.getByRole('button', { name: '返回聊天' })
  expect(back).toHaveFocus()
  fireEvent.click(back)
  expect(onDismiss).toHaveBeenCalledOnce()
})

test('设置页返回仍确认未保存的指令，取消后继续编辑，确认后先丢弃再离开', () => {
  const onDiscard = vi.fn()
  const onDismiss = vi.fn()
  render(
    <SettingsPage
      renderContent={() => <p>未保存的指令正文</p>}
      dirty
      saving={false}
      onDiscard={onDiscard}
      onDismiss={onDismiss}
    />,
  )

  fireEvent.click(screen.getByRole('button', { name: '返回聊天' }))
  expect(screen.getByRole('dialog')).toHaveTextContent('丢弃未保存的指令？')
  expect(onDismiss).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '继续编辑' }))
  expect(screen.getByText('未保存的指令正文')).toBeInTheDocument()
  expect(onDiscard).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: '返回聊天' }))
  fireEvent.click(screen.getByRole('button', { name: '丢弃修改' }))
  expect(onDiscard).toHaveBeenCalledOnce()
  expect(onDismiss).toHaveBeenCalledOnce()
  expect(onDiscard.mock.invocationCallOrder[0]).toBeLessThan(onDismiss.mock.invocationCallOrder[0])
})

test('保存指令期间禁用共用顶栏返回和分类导航', () => {
  const onDismiss = vi.fn()
  render(
    <SettingsPage
      renderContent={(section) => <p>{section}正文</p>}
      dirty
      saving
      onDiscard={vi.fn()}
      onDismiss={onDismiss}
    />,
  )

  const back = screen.getByRole('button', { name: '返回聊天' })
  const models = screen.getByRole('button', { name: '模型' })
  expect(back).toBeDisabled()
  expect(models).toBeDisabled()
  fireEvent.click(back)
  fireEvent.click(models)
  expect(onDismiss).not.toHaveBeenCalled()
  expect(screen.getByText('general正文')).toBeInTheDocument()
})
