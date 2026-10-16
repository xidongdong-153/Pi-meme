import { test } from '../../../tests/fixtures/desktop'

test('冷聊天通过计划候选发送首条消息，复制和导出完整文档', async ({ desktop }) => {
  await desktop.runNative('plan-composer')
})

test('父子 Agent 续跑、完成提示和已保存计划使用真实会话', async ({ desktop }) => {
  await desktop.selectProject()
  await desktop.runNative('collaboration-plan')
})
