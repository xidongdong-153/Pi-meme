import { expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test, openChat } from '../../../tests/fixtures/web'

test('设置导航可实际切换，返回聊天保留草稿', async ({ page, host }) => {
  await openChat(page, host.url)
  await page.getByRole('combobox', { name: '消息', exact: true }).fill('切换设置前的草稿')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect(page.getByTestId('storage-root')).toHaveText(path.join(host.root, 'userData'))
  await expect(page.getByText(/Web 和远程服务只读展示/)).toBeVisible()
  await expect(page.getByRole('button', { name: '更改目录', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '清理缓存', exact: true })).toHaveCount(0)
  const navigation = page.getByRole('navigation', { name: '设置分类' })
  await navigation.getByRole('button', { name: '指令', exact: true }).click()
  await expect(page.getByRole('button', { name: '编辑指令：agents', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '返回聊天', exact: true }).click()
  await expect(page.getByRole('combobox', { name: '消息', exact: true })).toHaveText('切换设置前的草稿')
})

test('技能、插件与 MCP 页面实际加载，空目录不会显示加载错误', async ({ page, host }) => {
  await openChat(page, host.url)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const navigation = page.getByRole('navigation', { name: '设置分类' })
  await navigation.getByRole('button', { name: '技能', exact: true }).click()
  const skills = page.getByRole('region', { name: '技能管理' })
  await skills.getByRole('tab', { name: /^系统/ }).click()
  await expect(skills.getByRole('tabpanel')).toContainText('Skill Creator')
  await navigation.getByRole('button', { name: '插件', exact: true }).click()
  await expect(page.getByRole('region', { name: '插件管理' })).toBeVisible()
  await navigation.getByRole('button', { name: 'MCP', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'MCP', exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('指令正文通过真实表单保存，重新进入后恢复已保存内容', async ({ page, host }) => {
  await openChat(page, host.url)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const navigation = page.getByRole('navigation', { name: '设置分类' })
  await navigation.getByRole('button', { name: '指令', exact: true }).click()
  await page.getByRole('button', { name: '编辑指令：agents', exact: true }).click()
  await page.getByRole('textbox', { name: '指令正文', exact: true }).fill('本地浏览器测试指令')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect
    .poll(() => readFile(path.join(host.root, 'userData/pi/AGENTS.md'), 'utf8').catch(() => ''))
    .toBe('本地浏览器测试指令')
  await navigation.getByRole('button', { name: '模型', exact: true }).click()
  await navigation.getByRole('button', { name: '指令', exact: true }).click()
  await page.getByRole('button', { name: '编辑指令：agents', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '指令正文', exact: true })).toHaveValue('本地浏览器测试指令')
})
