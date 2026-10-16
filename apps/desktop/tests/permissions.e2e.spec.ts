import { test } from '../../../tests/fixtures/desktop'

test('访问权限键盘切换、运行中禁用和历史恢复', async ({ desktop }) => {
  await desktop.seedConversation()
  await desktop.runNative('agent-access')
})
