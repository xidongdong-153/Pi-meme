import { expect, type Page } from '@playwright/test'
import type { TerminalRef, TerminalSnapshot } from '@pi-meme/contracts/app-host'
import { test } from '../../../tests/fixtures/desktop'

async function openTool(page: Page, title: string) {
  const expand = page.getByRole('button', { name: '展开右侧栏', exact: true })
  if (await expand.isVisible()) await expand.click()
  const tab = page.getByRole('tab', { name: title, exact: true })
  if (await tab.count()) await tab.click()
  else {
    const chooser = page.getByRole('tabpanel', { name: '工具', exact: true })
    if (!(await chooser.isVisible())) await page.getByRole('button', { name: '新建工具标签页', exact: true }).click()
    await chooser.getByRole('button', { name: title, exact: true }).click()
  }
  await expect(tab).toHaveAttribute('aria-selected', 'true')
}

test('文件补全支持目录、中文空格路径和键盘返回', async ({ desktop }) => {
  await desktop.selectProject()
  await desktop.runNative('file-completion')
})

test('文件与 Git 面板始终保留聊天，关闭标签后可重新打开', async ({ desktop }) => {
  await desktop.selectProject()
  const page = desktop.page
  await openTool(page, '文件')
  await page.getByRole('button', { name: '打开文件：README.md', exact: true }).click()
  await expect(page.getByLabel('文件编辑器：README.md', { exact: true })).toContainText('# 验收项目')
  await expect(page.getByRole('combobox', { name: '消息', exact: true })).toBeVisible()
  await openTool(page, '变更')
  await expect(page.getByRole('tabpanel', { name: '变更', exact: true })).toBeVisible()
  await page.getByRole('tab', { name: '变更', exact: true }).hover()
  await page.getByRole('button', { name: '关闭标签页：变更', exact: true }).click()
  await expect(page.getByRole('tab', { name: '变更', exact: true })).toHaveCount(0)
  await openTool(page, '变更')
})

test('真实终端输入、字体变化与会话切换保留 PTY 实例', async ({ desktop }) => {
  await desktop.seedConversation()
  const page = desktop.page
  const file = await page.evaluate(async () => (await window.piMemeClient!.getConnection()).sessionFile!)
  const opened = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/control') && response.request().postDataJSON()?.method === 'terminal.open',
  )
  await openTool(page, '终端')
  const terminal = (await (await opened).json()).result as TerminalSnapshot
  const input = page.locator('[aria-label="终端"] .xterm-helper-textarea')
  await expect(input).toBeFocused()
  await page.keyboard.insertText("printf '\\120\\124\\131\\137\\117\\113\\n'")
  await page.keyboard.press('Enter')
  const attach = () =>
    page.evaluate(
      async (ref: TerminalRef) => {
        const connection = await window.piPlatform!.getHostConnection()
        const response = await fetch(new URL('/api/control', connection.url), {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiVersion: 2, clientId: 'terminal-e2e', method: 'terminal.attach', args: [ref] }),
        })
        return (await response.json()).result as TerminalSnapshot
      },
      { hostId: terminal.hostId, terminalId: terminal.terminalId },
    )
  await expect.poll(async () => (await attach()).output).toContain('PTY_OK')
  const original = await attach()
  const font = await page.evaluate(() => {
    const value = document.documentElement.style.getPropertyValue('--code-size')
    document.documentElement.style.setProperty('--code-size', '24px')
    return value
  })
  await expect.poll(async () => (await attach()).cols).toBeLessThan(original.cols)
  await page.evaluate((value) => document.documentElement.style.setProperty('--code-size', value), font)
  await page.evaluate(async () => {
    await window.piMemeClient!.newSession()
  })
  await expect(page.getByRole('tab', { name: '终端', exact: true })).toHaveCount(0)
  await page.evaluate(async (sessionFile) => {
    await window.piMemeClient!.switchSession(sessionFile)
  }, file)
  await expect(page.getByRole('tab', { name: '终端', exact: true })).toBeVisible()
  await page.getByRole('tab', { name: '终端', exact: true }).click()
  await expect.poll(async () => (await attach()).output).toContain('PTY_OK')
  await input.focus()
  await page.keyboard.insertText('exit')
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await attach()).exited).toBe(true)
  await page.getByRole('tab', { name: '终端', exact: true }).hover()
  await page.getByRole('button', { name: '关闭标签页：终端', exact: true }).click()
  const reopened = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/control') && response.request().postDataJSON()?.method === 'terminal.open',
  )
  await openTool(page, '终端')
  expect(((await (await reopened).json()).result as TerminalSnapshot).terminalId).not.toBe(terminal.terminalId)
  await expect(input).toBeFocused()
})
