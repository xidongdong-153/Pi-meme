import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ModelsBridge } from '@pi-meme/contracts/desktop'
import type { ConfiguredProvider, ModelConfigSnapshot } from '@pi-meme/contracts/model-config'
import { ModelConfigForm } from '@pi-meme/models/ui/model-config/model-config-form'
import { ModelConfigSettings } from '@pi-meme/models/ui/model-config/model-config-settings'

afterEach(cleanup)
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})

const provider: ConfiguredProvider = {
  id: 'test',
  name: '测试服务商',
  baseUrl: 'https://example.com/v1',
  api: 'openai-completions',
  hasApiKey: false,
  models: [{ id: 'outside', name: '原有模型' }],
}
const snapshot: ModelConfigSnapshot = { path: '/test/models.json', revision: '1', providers: [provider] }

test('服务商标签支持键盘切换，并保留内置列表的搜索状态', async () => {
  const bridge = {
    getModelConfig: vi.fn(async () => snapshot),
    getDefaultModel: vi.fn(async () => null),
    getDefaultThinkingLevel: vi.fn(async () => null),
    listBuiltinProviders: vi.fn(async () => [
      { id: 'builtin', name: '内置测试服务商', configured: false, methods: [] },
    ]),
  } as unknown as ModelsBridge
  render(<ModelConfigSettings bridge={bridge} busy={false} models={[]} />)

  const builtinTab = screen.getByRole('tab', { name: '内置提供商' })
  const customTab = screen.getByRole('tab', { name: '自定义提供商' })
  expect(builtinTab).toHaveAttribute('aria-selected', 'true')
  expect(await screen.findByText('内置测试服务商')).toBeVisible()
  fireEvent.change(screen.getByRole('textbox', { name: '搜索内置服务商' }), { target: { value: 'builtin' } })
  builtinTab.focus()
  fireEvent.keyDown(builtinTab, { key: 'ArrowRight' })
  expect(customTab).toHaveFocus()
  expect(customTab).toHaveAttribute('aria-selected', 'true')
  expect(await screen.findByText('测试服务商')).toBeVisible()
  fireEvent.keyDown(customTab, { key: 'Home' })
  expect(builtinTab).toHaveFocus()
  expect(screen.getByRole('textbox', { name: '搜索内置服务商' })).toHaveValue('builtin')
  expect(bridge.listBuiltinProviders).toHaveBeenCalledTimes(1)
})

test('全选仅处理当前搜索结果，保留其他模型和已编辑参数', async () => {
  const user = userEvent.setup()
  const onSave = vi.fn(async () => true)
  const onClose = vi.fn()
  render(
    <ModelConfigForm
      provider={provider}
      snapshot={snapshot}
      busy={false}
      bridge={{ discoverModels: vi.fn(async () => [{ id: 'team-a' }, { id: 'team-b' }, { id: 'other-c' }]) }}
      onSave={onSave}
      onClose={onClose}
    />,
  )

  await user.click(screen.getByRole('button', { name: '获取模型列表' }))
  await user.type(screen.getByRole('textbox', { name: '搜索模型' }), 'team')
  const selectAll = screen.getByRole('checkbox', { name: '全选当前列表模型' }) as HTMLInputElement
  expect(selectAll).not.toBeChecked()
  await user.click(screen.getByRole('checkbox', { name: '选择模型 team-a' }))
  expect(selectAll.indeterminate).toBe(true)
  await user.type(screen.getByRole('textbox', { name: 'team-a 显示名称' }), '已编辑')
  await user.click(selectAll)
  expect(selectAll).toBeChecked()
  expect(screen.getByRole('checkbox', { name: '选择模型 team-b' })).toBeChecked()
  expect(screen.getByRole('textbox', { name: 'team-a 显示名称' })).toHaveValue('已编辑')
  expect(screen.getByRole('textbox', { name: 'outside 显示名称' })).toHaveValue('原有模型')
  await user.click(selectAll)
  expect(screen.queryByRole('textbox', { name: 'team-a 显示名称' })).not.toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: 'outside 显示名称' })).toHaveValue('原有模型')
  await user.clear(screen.getByRole('textbox', { name: '搜索模型' }))
  await user.type(screen.getByRole('textbox', { name: '搜索模型' }), '没有匹配的模型')
  expect(selectAll).toBeDisabled()
  await user.click(screen.getByRole('button', { name: '保存服务商' }))
  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: expect.objectContaining({ models: [expect.objectContaining({ id: 'outside' })] }),
    }),
  )
  expect(onClose).toHaveBeenCalledOnce()
})

test('思考强度在高级模型参数中设置并保存', async () => {
  const user = userEvent.setup()
  const onSave = vi.fn(async () => true)
  render(
    <ModelConfigForm
      provider={provider}
      snapshot={snapshot}
      busy={false}
      bridge={{ discoverModels: vi.fn(async () => []) }}
      onSave={onSave}
      onClose={vi.fn()}
    />,
  )

  const selected = screen.getByRole('region', { name: '已选模型设置' })
  const advanced = within(selected).getByRole('button', { name: '高级模型参数' })
  expect(advanced).toHaveAttribute('aria-expanded', 'false')
  expect(within(selected).queryByRole('checkbox', { name: 'outside 高' })).not.toBeInTheDocument()
  await user.click(advanced)
  const high = within(selected).getByRole('checkbox', { name: 'outside 高' })
  expect(high).toBeChecked()
  await user.click(high)
  await user.click(screen.getByRole('button', { name: '保存服务商' }))
  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: expect.objectContaining({
        models: [expect.objectContaining({ thinkingLevelMap: expect.objectContaining({ high: null }) })],
      }),
    }),
  )
})
