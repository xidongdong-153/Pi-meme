import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test, vi } from 'vitest'
import type { ImageGenerationApi, ImageGenerationConfig } from '@pi-meme/contracts/image-generation'
import { ImageGenerationSettings } from '../src/ui/image-generation-settings'

afterEach(cleanup)
const model = {
  id: 'first',
  name: '图片服务',
  baseUrl: 'https://example.com/v1',
  model: 'test-image',
  size: 'auto' as const,
  quality: 'auto' as const,
  hasApiKey: true,
}
function apiFixture() {
  let config: ImageGenerationConfig = { revision: '0', models: [] }
  const api: ImageGenerationApi = {
    getConfig: vi.fn(async () => config),
    saveModel: vi.fn(async (input) => {
      config = {
        revision: '1',
        models: [{ ...input.model, hasApiKey: Boolean(input.apiKey) }],
        defaultId: input.model.id,
      }
      return config
    }),
    setDefault: vi.fn(async () => config),
    deleteModel: vi.fn(async () => ({ revision: '2', models: [model] })),
    test: vi.fn(async () => {
      throw new Error('不应自动生成测试图片')
    }),
  }
  return {
    api,
    config: (next: ImageGenerationConfig) => {
      config = next
    },
  }
}

test('新增配置后显示默认模型，保存不会自动调用图片服务', async () => {
  const fixture = apiFixture()
  const user = userEvent.setup()
  render(<ImageGenerationSettings api={fixture.api} hostLabel="远程开发机" />)
  await screen.findByText(/尚未配置图片模型/)
  await user.click(screen.getByRole('button', { name: '添加模型' }))
  await user.type(screen.getByLabelText('配置名称'), '图片服务')
  await user.type(screen.getByLabelText('API Key'), 'secret-value')
  await user.type(screen.getByLabelText('模型 ID'), 'test-image')
  await user.click(screen.getByRole('button', { name: '保存' }))
  await screen.findByRole('heading', { name: '图片服务' })
  expect(screen.getByRole('combobox', { name: '默认图片模型' }).textContent).toContain('图片服务')
  expect(screen.getByText('配置保存到：远程开发机')).toBeTruthy()
  expect(fixture.api.test).not.toHaveBeenCalled()
})

test('保存失败保留输入，清除凭据发送显式标志，删除默认不自动替换', async () => {
  const fixture = apiFixture()
  fixture.config({ revision: '0', models: [model], defaultId: model.id })
  const save = vi.mocked(fixture.api.saveModel)
  save.mockRejectedValueOnce(new Error('凭据未保存'))
  const user = userEvent.setup()
  render(<ImageGenerationSettings api={fixture.api} hostLabel="此计算机" />)
  await screen.findByRole('heading', { name: '图片服务' })
  await user.click(screen.getByRole('button', { name: '编辑' }))
  await user.click(screen.getByRole('checkbox', { name: '清除已保存的 API Key' }))
  await user.click(screen.getByRole('button', { name: '保存' }))
  await waitFor(() => expect(save).toHaveBeenCalled())
  expect(save.mock.calls[0][0]).toMatchObject({ clearApiKey: true })
  expect((screen.getByLabelText('配置名称') as HTMLInputElement).value).toBe('图片服务')
  await user.click(screen.getByRole('button', { name: '取消' }))
  await user.click(screen.getByRole('button', { name: '删除' }))
  await user.click(screen.getByRole('button', { name: '确认删除' }))
  await waitFor(() =>
    expect(screen.getByRole('combobox', { name: '默认图片模型' }).textContent).toContain('未选择默认模型'),
  )
  expect(fixture.api.setDefault).not.toHaveBeenCalled()
})
