import { test } from '../../../tests/fixtures/desktop'

test('冷会话和历史读取不启动 Worker，后台消息仍可继续', async ({ desktop }) => {
  await desktop.runNative('lazy-sessions')
})

test('项目选择、Worktree 和草稿目标保持一致', async ({ desktop }) => {
  await desktop.runNative('project-selector')
})

test('侧栏菜单支持改名、置顶和删除，操作绑定真实目标', async ({ desktop }) => {
  await desktop.selectProject()
  await desktop.runNative('sidebar-menu')
})

test('侧栏搜索、显示和排序支持鼠标与键盘', async ({ desktop }) => {
  await desktop.selectProject()
  await desktop.runNative('sidebar-controls')
})

test('后台会话继续生成，切换与停止不影响另一项目', async ({ desktop }) => {
  await desktop.selectProject()
  await desktop.runNative('background-sessions')
})
