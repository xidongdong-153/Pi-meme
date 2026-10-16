import { test } from '../../../tests/fixtures/desktop'

test.describe('队列', () => {
  test.use({ agentMode: 'queue' })
  test('暂停、图片回填、编辑租约与按序发送使用同一真实请求', async ({ desktop }) => {
    await desktop.runNative('queue-composer')
  })
})

test.describe('运行计时', () => {
  test.use({ agentMode: 'pause' })
  test('暂停冻结计时和工作过程，恢复与停止保持正确时段', async ({ desktop }) => {
    await desktop.runNative('pause-display')
  })
})
