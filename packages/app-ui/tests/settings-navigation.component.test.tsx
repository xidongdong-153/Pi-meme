import '@testing-library/jest-dom/vitest'
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render as renderUi, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'
import { SubagentDefaultsSettings } from '@pi-meme/subagents/ui/subagent-defaults-settings'
import { SettingsPage } from '../src/settings/settings-page'

afterEach(cleanup)

function render(children: ReactNode) {
  return renderUi(<TooltipProvider>{children}</TooltipProvider>)
}

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

test('Agent 设置导航可进入子代理页面', () => {
  render(
    <SettingsPage
      renderContent={(section) => <p>{section}正文</p>}
      dirty={false}
      saving={false}
      onDiscard={vi.fn()}
      onDismiss={vi.fn()}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: '子代理' }))
  expect(screen.getByText('subagents正文')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '子代理' })).toHaveAttribute('aria-current', 'page')
})

test('子代理模型选择提交标识，恢复继承提交 null，保存仅禁用对应字段', () => {
  const onSave = vi.fn()
  const props = {
    models: [{ provider: 'test', id: 'selected', name: '测试模型', reasoning: true }],
    value: { model: null, thinkingLevel: null },
    loading: false,
    connected: true,
    pending: {},
    status: {},
    failed: {},
    onSave,
    onModels: vi.fn(),
  }
  const view = render(<SubagentDefaultsSettings {...props} />)
  fireEvent.keyDown(screen.getByRole('combobox', { name: '默认模型' }), { key: 'ArrowDown' })
  fireEvent.click(screen.getByRole('option', { name: 'test / 测试模型' }))
  expect(onSave).toHaveBeenLastCalledWith({ model: { provider: 'test', id: 'selected' } })
  view.rerender(
    <TooltipProvider>
      <SubagentDefaultsSettings {...props} value={{ model: props.models[0], thinkingLevel: null }} />
    </TooltipProvider>,
  )
  fireEvent.keyDown(screen.getByRole('combobox', { name: '默认模型' }), { key: 'ArrowDown' })
  fireEvent.click(screen.getByRole('option', { name: '继承主会话' }))
  expect(onSave).toHaveBeenLastCalledWith({ model: null })
  view.rerender(
    <TooltipProvider>
      <SubagentDefaultsSettings {...props} pending={{ thinkingLevel: 'low' }} />
    </TooltipProvider>,
  )
  expect(screen.getByRole('combobox', { name: '默认思考强度' })).toBeDisabled()
  expect(screen.getByRole('combobox', { name: '默认模型' })).toBeEnabled()
})
