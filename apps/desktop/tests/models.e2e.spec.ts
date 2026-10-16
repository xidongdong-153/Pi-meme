import { test } from '../../../tests/fixtures/desktop'

test.describe('首次配置', () => {
  test.use({ agentMode: 'empty-models' })
  test('从空配置获取模型列表、保存凭据并验证配置错误', async ({ desktop }) => {
    await desktop.runNative('model-config')
  })
})

test.describe('模型选择', () => {
  test.use({ agentMode: 'picker' })
  test('模型搜索、末项选择和小窗口滚动边界', async ({ desktop }) => {
    await desktop.runNative('model-picker')
  })
})
