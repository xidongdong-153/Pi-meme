const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { shell, clipboard } = require('electron')

module.exports = async function sidebarMenuSmoke(window, waitFor, directory, screenshots, projectDirectory) {
  const { evaluate, focusWindow, pressKey, capture } = require('./desktop-test-helpers.cjs').desktopTestHelpers(
    window,
    waitFor,
    screenshots,
  )
  let originalClipboard
  try {
    await focusWindow()
    await evaluate(`(() => {
    window.sidebarWindowBlurCount = 0;
    window.addEventListener('blur',()=>window.sidebarWindowBlurCount++);
  })()`)
    const target = path.join(projectDirectory, 'sidebar-menu-project')
    const other = path.join(projectDirectory, 'sidebar-menu-other')
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
      await focusWindow()
      await waitFor(
        () =>
          evaluate(
            `[...document.querySelectorAll(${JSON.stringify(selector)})].some(row=>row.checkVisibility() && !row.closest('[inert]') && row.querySelector('[aria-label^="更多操作"]'))`,
          ),
        '更多操作所在行可见',
      )
      await evaluate(
        `(() => { const row = [...document.querySelectorAll(${JSON.stringify(selector)})].find(node=>node.checkVisibility() && !node.closest('[inert]')); const trigger = row.querySelector('[aria-label^="更多操作"]'); trigger.scrollIntoView({block:'nearest'}); trigger.focus(); })()`,
      )
      await waitFor(
        () => evaluate(`document.activeElement?.getAttribute('aria-label')?.startsWith('更多操作')`),
        '更多操作按钮获得焦点',
      )
      await pressKey('Enter')
      try {
        await waitFor(
          () => evaluate('document.activeElement?.closest("[role=menu]")?.dataset.state === "open"'),
          '更多菜单聚焦',
        )
      } catch (cause) {
        console.error(
          '更多菜单焦点诊断',
          await evaluate(`({
          active:document.activeElement?.outerHTML,
          focused:document.hasFocus(),
          rows:[...document.querySelectorAll(${JSON.stringify(selector)})].map(node=>({visible:node.checkVisibility(),rects:node.getClientRects().length,project:node.dataset.projectCwd,session:node.dataset.sessionPath,html:node.outerHTML})),
          menus:[...document.querySelectorAll('[role="menu"]')].map(node=>({visible:node.checkVisibility(),html:node.outerHTML})),
        })`),
        )
        throw cause
      }
      await evaluate('new Promise(resolve => requestAnimationFrame(resolve))')
    }
    const selectItem = async (text) => {
      const ready = () =>
        waitFor(
          () =>
            evaluate(
              `[...document.querySelectorAll('[role="menu"][data-state="open"] [role="menuitem"]')].some(node=>node.checkVisibility() && node.textContent.trim() === ${JSON.stringify(text)})`,
            ),
          `可见菜单操作：${text}`,
        )
      await ready()
      await evaluate(
        `Array.from(document.querySelectorAll('[role="menu"][data-state="open"] [role="menuitem"]')).find(node => node.checkVisibility() && node.textContent.trim() === ${JSON.stringify(text)}).focus()`,
      )
      await pressKey('Enter')
      await waitFor(() => evaluate('!document.querySelector("[role=menu]")'), '菜单选择后退场完成')
      await evaluate('new Promise(resolve => setTimeout(resolve, 0))')
    }
    const escape = async () => {
      await pressKey('Escape')
      await waitFor(() => evaluate('!document.querySelector("[role=menu]")'), '关闭菜单')
      await waitFor(
        () => evaluate('document.activeElement?.getAttribute("aria-label")?.startsWith("更多操作")'),
        '关闭菜单恢复触发按钮焦点',
      )
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
      await waitFor(
        () =>
          evaluate(
            '!document.querySelector("[role=dialog]") && document.activeElement?.getAttribute("aria-label")?.startsWith("更多操作")',
          ),
        '重命名弹窗关闭并恢复菜单按钮焦点',
      )
    }
    const theme = async (appearance) => {
      await evaluate(`document.querySelector('button[aria-label="设置"]').click()`)
      await waitFor(() => evaluate('Boolean(document.querySelector("nav[aria-label=设置分类]"))'), '设置页')
      await evaluate(
        `Array.from(document.querySelectorAll('nav[aria-label="设置分类"] button')).find(node => node.textContent.trim() === '外观').click()`,
      )
      await waitFor(() => evaluate('Boolean(document.querySelector(\'[aria-label="深色模式"]\'))'), '外观页面加载')
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
    assert.equal(await evaluate(`Boolean(document.querySelector('[data-sidebar-section="pinned"]'))`), false)
    const effectiveOpacity = `(node, root) => { let opacity = 1; while (node) { opacity *= Number(getComputedStyle(node).opacity); if (node === root) break; node = node.parentElement; } return opacity; }`
    const hover = async (selector) => {
      const point = await evaluate(
        `(() => { const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }; })()`,
      )
      window.webContents.sendInputEvent({ type: 'mouseMove', ...point })
    }
    const moveAway = () => window.webContents.sendInputEvent({ type: 'mouseMove', x: 1000, y: 100 })
    const projectAppearance = () =>
      evaluate(
        `(() => { const row = document.querySelector(${JSON.stringify(projectSelector)}); const opacity = ${effectiveOpacity}; const folder = row.querySelector('[data-project-folder-icon]'); return { folder: folder ? opacity(folder, row) : null, chevron: Boolean(row.querySelector('[data-project-chevron-icon]')), actions: [...row.querySelectorAll('button')].slice(1).map(button => opacity(button, row)) }; })()`,
      )
    const assertProjectActions = async (visible, label, hoverSelector) => {
      await waitFor(async () => {
        if (hoverSelector) await hover(hoverSelector)
        return (await projectAppearance()).actions.every((opacity) => opacity === visible)
      }, label)
      assert.deepEqual(await projectAppearance(), { folder: 1, chevron: false, actions: [visible, visible, visible] })
    }
    const sectionHeaderSelector = '[data-sidebar-section="projects"] > div:first-child'
    const sectionAppearance = (headerSelector = sectionHeaderSelector) =>
      evaluate(
        `(() => { const header = document.querySelector(${JSON.stringify(headerSelector)}); const opacity = ${effectiveOpacity}; return [...header.querySelectorAll('button:not([aria-controls])')].map(button => opacity(button, header)); })()`,
      )
    const assertSectionActions = async (visible, label, hoverSelector, headerSelector = sectionHeaderSelector) => {
      await waitFor(async () => {
        if (hoverSelector) await hover(hoverSelector)
        return (await sectionAppearance(headerSelector)).every((opacity) => opacity === visible)
      }, label)
      assert.deepEqual(await sectionAppearance(headerSelector), [visible, visible])
    }
    const checkSectionHover = async (headerSelector = sectionHeaderSelector) => {
      moveAway()
      await evaluate(
        `document.querySelector(${JSON.stringify(headerSelector)}).querySelector('button[aria-controls]').focus()`,
      )
      await assertSectionActions(0, '分区标题获得焦点时操作按钮隐藏', undefined, headerSelector)
      await assertSectionActions(1, '鼠标悬停分区标题时操作按钮显现', headerSelector, headerSelector)
      moveAway()
      await assertSectionActions(0, '鼠标离开已展开分区标题后操作按钮隐藏', undefined, headerSelector)
    }
    moveAway()
    await evaluate(`document.querySelector('[aria-label="侧边栏显示选项"]').focus()`)
    await assertProjectActions(0, '默认项目操作按钮隐藏')
    await assertProjectActions(1, '鼠标悬停项目时保留文件夹并显示操作按钮', projectSelector)
    await assertSectionActions(0, '鼠标悬停项目内容时分区标题操作按钮隐藏')
    await capture('sidebar-project-hover-dark')
    moveAway()
    await evaluate(
      `document.querySelector(${JSON.stringify(projectSelector)}).querySelector('button[aria-expanded]').focus()`,
    )
    await assertProjectActions(0, '项目获得键盘焦点时操作按钮隐藏')
    await evaluate(
      `document.querySelector(${JSON.stringify(projectSelector)}).querySelector('[aria-label^="更多操作"]').focus()`,
    )
    await assertProjectActions(0, '项目右侧按钮获得焦点时操作按钮隐藏')
    await checkSectionHover()
    await openMore(projectSelector)
    assert.equal(await evaluate('window.piMemeClient.getConnection().then(value => value.sessionKey)'), keyBefore)
    await assertProjectActions(0, '项目更多菜单打开时鼠标移开仍隐藏操作按钮')
    await capture('sidebar-project-menu-dark')
    await pressKey('ArrowDown')
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
      () =>
        evaluate(
          `document.querySelectorAll(${JSON.stringify(projectSelector)}).length === 1 && Boolean(document.querySelector(${JSON.stringify(projectSelector)}).closest('[data-sidebar-section="pinned"]'))`,
        ),
      '项目仅在置顶分区显示',
    )
    await openMore(projectSelector)
    assert.equal(
      await evaluate(
        `Array.from(document.querySelectorAll('[role="menuitem"]')).some(node => node.textContent.trim() === '取消置顶')`,
      ),
      true,
    )
    // 复制走渲染进程的 Clipboard API，文档必须处于焦点状态。
    originalClipboard = await clipboard.readText()
    await waitFor(() => evaluate('document.hasFocus()'), '窗口获得焦点')
    await selectItem('复制项目路径')
    await waitFor(async () => (await clipboard.readText()) === target, '项目路径复制')
    const openPath = shell.openPath
    let opened
    shell.openPath = async (cwd) => {
      opened = cwd
      return ''
    }
    try {
      await openMore(projectSelector)
      await evaluate(
        `Array.from(document.querySelectorAll('[role="menuitem"]')).find(node => node.textContent.includes('在…打开')).focus()`,
      )
      await pressKey('ArrowRight')
      await waitFor(
        () =>
          evaluate(
            `Array.from(document.querySelectorAll('[role="menuitem"]')).some(node => node.textContent === '系统文件管理器')`,
          ),
        '打开方式子菜单',
      )
      await capture('sidebar-project-open-submenu')
      await selectItem('系统文件管理器')
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
    assert.equal(
      await evaluate(
        `document.querySelector(${JSON.stringify(projectSelector)}).querySelector('button[aria-expanded]').getAttribute('aria-expanded')`,
      ),
      'true',
    )
    await assertProjectActions(1, '展开项目悬停时操作按钮显现', projectSelector)
    moveAway()
    await assertProjectActions(0, '展开项目鼠标移开后操作按钮隐藏')
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
    await waitFor(
      () =>
        evaluate(
          '!document.querySelector("[role=dialog]") && document.activeElement?.getAttribute("aria-label")?.startsWith("更多操作")',
        ),
      '取消删除恢复菜单按钮焦点',
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
  } finally {
    if (originalClipboard !== undefined) await clipboard.writeText(originalClipboard)
  }
}
