import { expect } from '@playwright/test'
import { test, openChat } from '../../../tests/fixtures/web'

test('真实 Host 与 Worker 完成消息，刷新恢复正文且不重复发送', async ({ page, host }) => {
  await openChat(page, host.url)
  await page.getByRole('combobox', { name: '消息', exact: true }).fill('浏览器首条消息')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  const flow = page.getByLabel('对话消息流', { exact: true })
  await expect(flow.getByText('本地模型完整回复', { exact: true })).toBeVisible()
  await expect
    .poll(() => page.evaluate(async () => (await window.piMemeClient!.getSnapshot()).state.isStreaming))
    .toBe(false)
  await page.reload()
  await expect(flow.getByText('浏览器首条消息', { exact: true })).toBeVisible()
  await expect(flow.getByText('本地模型完整回复', { exact: true })).toHaveCount(1)
})

test('停止后继续真实任务，保留原输入且不重复发送', async ({ page, host }) => {
  await openChat(page, host.url)
  await page.getByRole('combobox', { name: '消息', exact: true }).fill('等待停止')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByLabel('对话消息流', { exact: true })).toContainText('正在等待停止操作')
  await page.getByRole('button', { name: '停止当前任务', exact: true }).click()
  await expect
    .poll(() => page.evaluate(async () => (await window.piMemeClient!.getSnapshot()).state.stopped))
    .toBe(true)
  host.releaseReply()
  await page.getByRole('button', { name: '继续当前任务', exact: true }).click()
  await expect
    .poll(() => page.evaluate(async () => (await window.piMemeClient!.getSnapshot()).state.stopped))
    .toBe(false)
  await expect
    .poll(() => page.evaluate(async () => (await window.piMemeClient!.getSnapshot()).state.isStreaming))
    .toBe(false)
  await expect(page.getByLabel('对话消息流', { exact: true }).getByText('等待停止', { exact: true })).toHaveCount(1)
  await expect(page.getByRole('combobox', { name: '消息', exact: true })).toHaveAttribute('contenteditable', 'true')
})
