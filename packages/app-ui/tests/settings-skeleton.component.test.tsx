import '@testing-library/jest-dom/vitest'
import { afterEach, expect, test } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { BentoSkeletonCard } from '@pi-meme/ui/components/bento-skeleton'
import { SettingsSkeleton } from '../src/settings/settings-skeleton'
import { SettingsPage } from '../src/settings/settings-page'

afterEach(cleanup)

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
