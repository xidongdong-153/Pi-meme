import { expect } from '@playwright/test'
import { test, openChat } from '../../../tests/fixtures/web'

test('编辑覆盖原对话，刷新保留修改，分叉后保留修改后的上下文', async ({ page, host }) => {
  await openChat(page, host.url)
  const composer = page.getByRole('combobox', { name: '消息', exact: true })
  await composer.fill('原始提问')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByLabel('对话消息流', { exact: true })).toContainText('本地模型完整回复')
  await expect
    .poll(() => page.evaluate(async () => (await window.piMemeClient!.getSnapshot()).state.isStreaming))
    .toBe(false)
  const originalFile = await page.evaluate(async () => (await window.piMemeClient!.getConnection()).sessionFile!)
  await page.getByRole('button', { name: '编辑消息', exact: true }).first().click()
  const editor = page.getByLabel('编辑历史消息', { exact: true }).getByRole('combobox', { name: '消息', exact: true })
  await editor.fill('修改后的提问')
  await page.getByRole('button', { name: '发送编辑后的消息', exact: true }).click()
  const flow = page.locator('[aria-label="对话消息流"]:visible')
  await expect(flow.getByText('修改后的提问', { exact: true })).toBeVisible()
  await expect
    .poll(() => page.evaluate(async () => (await window.piMemeClient!.getSnapshot()).state.isStreaming))
    .toBe(false)
  expect(await page.evaluate(async () => (await window.piMemeClient!.getConnection()).sessionFile)).toBe(originalFile)
  await page.reload()
  await expect(flow.getByText('修改后的提问', { exact: true })).toBeVisible()
  await expect(flow.getByText('原始提问', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '从这段回复新建会话', exact: true }).first().click()
  await expect
    .poll(() =>
      page.evaluate(
        async (original) => (await window.piMemeClient!.getConnection()).sessionFile !== original,
        originalFile,
      ),
    )
    .toBe(true)
  await expect(flow.getByText('修改后的提问', { exact: true })).toBeVisible()
  await expect(flow.getByText('原始提问', { exact: true })).toHaveCount(0)
})
