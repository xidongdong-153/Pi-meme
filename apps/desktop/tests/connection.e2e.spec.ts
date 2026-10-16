import { expect } from '@playwright/test'
import { test } from '../../../tests/fixtures/desktop'

test('Electron 平台桥可用，认证 Session 不持久化 Cookie', async ({ desktop }) => {
  expect(await desktop.page.evaluate(() => typeof window.piPlatform?.getHostConnection)).toBe('function')
  expect(
    await desktop.app.evaluate(({ BrowserWindow }) => {
      const session = BrowserWindow.getAllWindows()[0].webContents.session
      return { persistent: session.isPersistent(), storagePath: session.storagePath }
    }),
  ).toEqual({ persistent: false, storagePath: null })
})

test('快速会话选择与迟到响应不会覆盖当前输入目标', async ({ desktop }) => {
  await desktop.runNative('session-switch')
})

test('多个 Host 的相同路径保持会话、草稿和侧栏隔离', async ({ desktop }) => {
  await desktop.runNative('multi-service')
})
