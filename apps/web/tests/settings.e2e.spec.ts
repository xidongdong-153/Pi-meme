import { expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { storageLayoutRelativePaths } from '@pi-meme/contracts/storage-paths'
import { test, openChat } from '../../../tests/fixtures/web'

test('指令真实保存并重新读取，设置导航保留聊天草稿且浏览器不能维护存储', async ({ page, host }) => {
  await openChat(page, host.url)
  await page.getByRole('combobox', { name: '消息', exact: true }).fill('切换设置前的草稿')
  await page.getByRole('button', { name: '用户菜单与设置', exact: true }).click()
  await page.getByRole('menuitem', { name: /^设置/ }).click()
  await expect(page.getByTestId('storage-root')).toHaveText(path.join(host.root, 'userData'))
  await expect(page.getByRole('button', { name: '更改目录', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '清理缓存', exact: true })).toHaveCount(0)
  const navigation = page.getByRole('navigation', { name: '设置分类' })
  await navigation.getByRole('button', { name: '指令', exact: true }).click()
  await page.getByRole('button', { name: '编辑指令：agents', exact: true }).click()
  await page.getByRole('textbox', { name: '指令正文', exact: true }).fill('本地浏览器测试指令')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect
    .poll(() =>
      readFile(path.join(host.root, 'userData', storageLayoutRelativePaths.agentAgentsFile), 'utf8').catch(() => ''),
    )
    .toBe('本地浏览器测试指令')
  await navigation.getByRole('button', { name: '模型', exact: true }).click()
  await navigation.getByRole('button', { name: '指令', exact: true }).click()
  await page.getByRole('button', { name: '编辑指令：agents', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '指令正文', exact: true })).toHaveValue('本地浏览器测试指令')
  await page.getByRole('button', { name: '首页', exact: true }).click()
  await expect(page.getByRole('combobox', { name: '消息', exact: true })).toHaveText('切换设置前的草稿')
})
