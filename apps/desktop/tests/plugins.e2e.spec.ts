import { test } from '../../../tests/fixtures/desktop'
import { expect } from '@playwright/test'
import path from 'node:path'

test('App 插件显示、作用域和命令失败保留会话', async ({ desktop }) => {
  await desktop.selectProject()
  await desktop.runNative('extensions')
})

test('外部主题通过认证资源加载真实图片，停用后恢复内置外观', async ({ desktop }) => {
  const page = desktop.page
  await page.evaluate(async (directory) => {
    const connection = await window.piPlatform!.getHostConnection()
    const response = await fetch(new URL('/api/rpc', connection.url), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        clientId: 'theme-e2e',
        method: 'plugins:install-directory',
        args: [directory],
      }),
    })
    const result = await response.json()
    if (!response.ok || result.error) throw new Error(result.error?.message ?? '主题安装失败')
  }, path.resolve('plugins/theme-landscape'))
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const navigation = page.getByRole('navigation', { name: '设置分类' })
  await navigation.getByRole('button', { name: '外观', exact: true }).click()
  await page.getByRole('button', { name: '深色模式', exact: true }).click()
  await page.getByRole('combobox', { name: '外观主题', exact: true }).click()
  await page.getByRole('option', { name: /山色/ }).click()
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.themeBackground)).toBe('workspace')
  const image = await page.evaluate(async () => {
    const background = getComputedStyle(document.querySelector('.theme-workspace')!, '::before').backgroundImage
    const url = background.slice(4, -1).replace(/^"|"$/g, '')
    const picture = new Image()
    picture.src = url
    await picture.decode()
    return { width: picture.naturalWidth, url }
  })
  expect(image.width).toBeGreaterThan(0)
  expect(image.url).toContain('/api/plugins/')
  await navigation.getByRole('button', { name: '插件', exact: true }).click()
  const plugin = page.getByRole('button', { name: '查看插件：@pi-meme/theme-landscape', exact: true }).locator('..')
  await plugin.getByRole('switch').click()
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.themeBackground)).not.toBe('workspace')
})
