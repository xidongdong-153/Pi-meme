const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { shell, clipboard } = require('electron')

module.exports = async function sidebarMenuSmoke(window, waitFor, directory, screenshots) {
  const evaluate = (code) =>
    window.webContents.executeJavaScript(code).catch(async (cause) => {
      const menus = await window.webContents.executeJavaScript(`
        [...document.querySelectorAll('[role="menu"]')].map(node => ({
          state: node.dataset.state,
          visible: Boolean(node.getClientRects().length),
          items: [...node.querySelectorAll('[role="menuitem"]')].map(item => item.textContent.trim()),
        }))
      `)
      throw new Error(`侧栏菜单验收脚本执行失败：${code}；当前菜单：${JSON.stringify(menus)}`, { cause })
    })
  const target = path.join(directory, 'sidebar-menu-project')
  const other = path.join(directory, 'sidebar-menu-other')
  await fs.mkdir(target)
  await fs.mkdir(other)
  await fs.writeFile(path.join(target, 'keep.ts'), 'export const value = 1\n')
  const folder = require('./runtime-paths.cjs').sessionDirectory(directory, target)
  await fs.mkdir(folder, { recursive: true })
  const files = ['first', 'second'].map((name) => path.join(folder, `${name}.jsonl`))
  for (const [index, file] of files.entries()) {
    const timestamp = new Date().toISOString()
    await fs.writeFile(
      file,
      `${[
        { type: 'session', id: `sidebar-${index}`, version: 3, timestamp, cwd: target },
        {
          type: 'message',
          id: 'user',
          parentId: null,
          timestamp,
          message: { role: 'user', content: `菜单测试会话 ${index}`, timestamp: Date.now() },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n')}\n`,
    )
  }
  await evaluate(`window.piMemeClient.selectWorkspace({ kind: 'project', cwd: ${JSON.stringify(target)} })`)
  await evaluate(`window.piMemeClient.selectWorkspace({ kind: 'project', cwd: ${JSON.stringify(other)} })`)
  await waitFor(() => evaluate(`Boolean(document.querySelector('[data-project-cwd="${target}"]'))`), '菜单测试项目')
  const projectSelector = `[data-project-cwd="${target}"]`
  const sessionSelector = `[data-session-path="${files[0]}"]`
  const keyBefore = await evaluate('window.piMemeClient.getConnection().then(value => value.sessionKey)')
  const openMore = async (selector) => {
    await evaluate(
      `document.querySelector(${JSON.stringify(selector)}).querySelector('[aria-label^="更多操作"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`,
    )
    await waitFor(() => evaluate('Boolean(document.querySelector("[role=menu]"))'), '更多菜单')
  }
  const selectItem = async (text) => {
    await evaluate(
      `Array.from(document.querySelectorAll('[role="menuitem"]')).find(node => node.textContent.trim() === ${JSON.stringify(text)}).click()`,
    )
  }
  const escape = async () => {
    await evaluate(
      `document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
    )
    await waitFor(() => evaluate('!document.querySelector("[role=menu]")'), '关闭菜单')
  }
  const capture = async (name) => {
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    await fs.writeFile(path.join(screenshots, `${name}.png`), (await window.webContents.capturePage()).toPNG())
  }
  const rename = async (value) => {
    await waitFor(() => evaluate('Boolean(document.querySelector("input[aria-label=名称]"))'), '名称弹窗')
    await waitFor(
      () => evaluate('document.activeElement === document.querySelector("input[aria-label=名称]")'),
      '名称输入框聚焦',
    )
    assert.equal(
      await evaluate(
        'document.activeElement.selectionEnd === document.activeElement.value.length && document.activeElement.selectionStart === 0',
      ),
      true,
    )
    await evaluate(
      `(() => { const input = document.querySelector('input[aria-label="名称"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
    )
    await evaluate(
      `document.querySelector('#sidebar-rename').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))`,
    )
    await waitFor(() => evaluate('!document.querySelector("input[aria-label=名称]")'), '名称已保存')
  }
  const theme = async (appearance) => {
    await evaluate(`document.querySelector('button[aria-label="设置"]').click()`)
    await waitFor(() => evaluate('Boolean(document.querySelector("nav[aria-label=设置分类]"))'), '设置页')
    await evaluate(
      `Array.from(document.querySelectorAll('nav[aria-label="设置分类"] button')).find(node => node.textContent.trim() === '外观').click()`,
    )
    await evaluate(`document.querySelector('[aria-label="${appearance === 'dark' ? '深色' : '浅色'}模式"]').click()`)
    await waitFor(
      () => evaluate(`document.documentElement.dataset.appearance === ${JSON.stringify(appearance)}`),
      '菜单主题已应用',
    )
    await evaluate(
      `Array.from(document.querySelectorAll('button')).find(node => node.textContent.trim() === '返回聊天').click()`,
    )
  }
  await theme('dark')
  await openMore(projectSelector)
  assert.equal(await evaluate('window.piMemeClient.getConnection().then(value => value.sessionKey)'), keyBefore)
  await capture('sidebar-project-menu-dark')
  await evaluate(
    `document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`,
  )
  await waitFor(() => evaluate('document.activeElement?.getAttribute("role") === "menuitem"'), '方向键移动菜单焦点')
  await escape()
  await openMore(projectSelector)
  await selectItem('编辑名称')
  await rename('菜单项目新名称')
  await waitFor(
    () =>
      evaluate(`document.querySelector(${JSON.stringify(projectSelector)})?.textContent.includes('菜单项目新名称')`),
    '项目名称更新',
  )
  await openMore(projectSelector)
  await selectItem('置顶')
  await waitFor(
    () => evaluate(`document.querySelectorAll(${JSON.stringify(projectSelector)}).length === 2`),
    '项目置顶重复入口',
  )
  await openMore(projectSelector)
  assert.equal(
    await evaluate(
      `Array.from(document.querySelectorAll('[role="menuitem"]')).some(node => node.textContent.trim() === '取消置顶')`,
    ),
    true,
  )
  const originalClipboard = await clipboard.readText()
  try {
    // 复制走渲染进程的 Clipboard API，文档必须处于焦点状态。
    window.show()
    window.focus()
    window.webContents.focus()
    await waitFor(() => evaluate('document.hasFocus()'), '窗口获得焦点')
    await selectItem('复制项目路径')
    await waitFor(async () => (await clipboard.readText()) === target, '项目路径复制')
  } finally {
    await clipboard.writeText(originalClipboard)
  }
  const openPath = shell.openPath
  let opened
  shell.openPath = async (cwd) => {
    opened = cwd
    return ''
  }
  try {
    await openMore(projectSelector)
    await evaluate(
      `Array.from(document.querySelectorAll('[role="menuitem"]')).find(node => node.textContent.includes('在…中打开')).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`,
    )
    await waitFor(
      () =>
        evaluate(
          `Array.from(document.querySelectorAll('[role="menuitem"]')).some(node => node.textContent === 'Finder')`,
        ),
      '打开方式子菜单',
    )
    await capture('sidebar-project-open-submenu')
    await selectItem('Finder')
    await waitFor(() => opened === target, '打开菜单所属项目')
    assert.equal(await evaluate('window.piMemeClient.getConnection().then(value => value.cwd)'), other)
  } finally {
    shell.openPath = openPath
  }
  await evaluate(
    `(() => { const row = document.querySelector(${JSON.stringify(projectSelector)}); row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2, clientX: innerWidth - 4, clientY: innerHeight - 4 })); })()`,
  )
  await waitFor(() => evaluate('Boolean(document.querySelector("[role=menu]"))'), '右键菜单')
  await waitFor(
    () =>
      evaluate(
        `(() => { const rect = document.querySelector('[role="menu"]').getBoundingClientRect(); return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight })()`,
      ),
    '菜单边缘避让',
  )
  await escape()
  await evaluate(
    `document.querySelector(${JSON.stringify(projectSelector)}).querySelector('button[aria-expanded]').click()`,
  )
  await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(sessionSelector)}))`), '项目会话列表')
  await openMore(sessionSelector)
  await selectItem('重命名')
  await rename('菜单会话新名称')
  await waitFor(
    () =>
      evaluate(`document.querySelector(${JSON.stringify(sessionSelector)})?.textContent.includes('菜单会话新名称')`),
    '会话名称更新',
  )
  await openMore(sessionSelector)
  await selectItem('永久删除')
  await waitFor(() => evaluate('Boolean(document.querySelector("[role=dialog]"))'), '会话删除确认')
  await evaluate(
    `Array.from(document.querySelectorAll('[role="dialog"] button')).find(node => node.textContent === '取消').click()`,
  )
  await fs.readFile(files[0])
  await theme('light')
  await openMore(sessionSelector)
  await capture('sidebar-session-menu-light')
  await escape()
  await openMore(projectSelector)
  await selectItem('移除项目并删除全部会话')
  await waitFor(
    () => evaluate(`document.querySelector('[role="dialog"]')?.textContent.includes('2 个会话')`),
    '项目删除数量',
  )
  await capture('sidebar-project-delete-confirmation')
  await evaluate(
    `Array.from(document.querySelectorAll('[role="dialog"] button')).find(node => node.textContent === '永久删除').click()`,
  )
  await waitFor(() => evaluate(`!document.querySelector(${JSON.stringify(projectSelector)})`), '项目移除完成')
  for (const file of files) await assert.rejects(fs.readFile(file), { code: 'ENOENT' })
  await fs.readFile(path.join(target, 'keep.ts'))
  assert.equal(await evaluate('window.piMemeClient.getConnection().then(value => value.cwd)'), other)
}
