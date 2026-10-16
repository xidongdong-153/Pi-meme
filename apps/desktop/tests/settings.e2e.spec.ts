import { test } from '../../../tests/fixtures/desktop'
import { expect } from '@playwright/test'

test('外观修改保存、系统主题和原生文件对话框', async ({ desktop }) => {
  await desktop.page.getByRole('button', { name: '设置', exact: true }).click()
  await desktop.page
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: '外观', exact: true })
    .click()
  await desktop.runNative('appearance')
  const fonts = await desktop.page.evaluate(() => window.piMemeClient!.getInstalledFonts())
  expect(fonts.length).toBeGreaterThan(0)
})

test('下拉键盘交互、关闭动画与焦点恢复', async ({ desktop }) => {
  await desktop.runNative('select-controls')
})

test('用量页面读取真实 JSONL 并按月展示和刷新', async ({ desktop }) => {
  await desktop.page.getByRole('button', { name: '设置', exact: true }).click()
  await desktop.runNative('profile')
})

test('MCP 配置保存、诊断和真实 stdio 服务清理', async ({ desktop }) => {
  await desktop.runNative('mcp')
})
