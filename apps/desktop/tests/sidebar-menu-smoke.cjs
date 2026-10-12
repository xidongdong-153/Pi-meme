const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { shell, clipboard } = require('electron')

module.exports = async function sidebarMenuSmoke(window, waitFor, directory, screenshots) {
  const evaluate = async (code) => {
    let timer
    const execution = window.webContents.executeJavaScript(code).catch(async (cause) => {
      const menus = await window.webContents.executeJavaScript(`
        [...document.querySelectorAll('[role="menu"]')].map(node => ({
          state: node.dataset.state,
          visible: Boolean(node.getClientRects().length),
          items: [...node.querySelectorAll('[role="menuitem"]')].map(item => item.textContent.trim()),
        }))
      `)
      throw new Error(`侧栏菜单验收脚本执行失败：${code}；当前菜单：${JSON.stringify(menus)}`, { cause })
    })
    try {
      return await Promise.race([
        execution,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`侧栏菜单验收执行超过 10 秒：${code}`)), 10000)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  window.show()
  window.focus()
  window.webContents.focus()
  await waitFor(() => evaluate('document.hasFocus()'), '侧栏验收窗口获得焦点')
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
      `(() => { const trigger = document.querySelector(${JSON.stringify(selector)}).querySelector('[aria-label^="更多操作"]'); trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`,
    )
    await waitFor(() => evaluate('Boolean(document.activeElement?.closest("[role=menu]"))'), '更多菜单聚焦')
    await evaluate('new Promise(resolve => requestAnimationFrame(resolve))')
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
  const sectionAppearance = () =>
    evaluate(
      `(() => { const header = document.querySelector(${JSON.stringify(sectionHeaderSelector)}); const opacity = ${effectiveOpacity}; return [...header.querySelectorAll('button:not([aria-controls])')].map(button => opacity(button, header)); })()`,
    )
  const assertSectionActions = async (visible, label, hoverSelector) => {
    await waitFor(async () => {
      if (hoverSelector) await hover(hoverSelector)
      return (await sectionAppearance()).every((opacity) => opacity === visible)
    }, label)
    assert.deepEqual(await sectionAppearance(), [visible, visible])
  }
  const checkSectionHover = async () => {
    moveAway()
    await evaluate(
      `document.querySelector(${JSON.stringify(sectionHeaderSelector)}).querySelector('button[aria-controls]').focus()`,
    )
    await assertSectionActions(0, '分区标题获得焦点时操作按钮隐藏')
    await assertSectionActions(1, '鼠标悬停分区标题时操作按钮显现', sectionHeaderSelector)
    moveAway()
    await assertSectionActions(0, '鼠标离开已展开分区标题后操作按钮隐藏')
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
  await fs.readFile(files[0])
  await theme('light')
  await openMore(sessionSelector)
  await capture('sidebar-session-menu-light')
  await escape()
  const originalSidebar = await evaluate('window.piMemeClient.getSettings().then(value => value.settings.sidebar)')
  const searchProject = path.join(directory, 'sidebar-search-project')
  const searchFolder = require('./runtime-paths.cjs').sessionDirectory(directory, searchProject)
  const searchFiles = []
  await fs.mkdir(searchProject)
  await fs.mkdir(searchFolder, { recursive: true })
  for (let index = 0; index < 35; index++) {
    const file = path.join(searchFolder, `search-${index}.jsonl`)
    searchFiles.push(file)
    const timestamp = new Date(Date.now() - (index + 1) * 86400000).toISOString()
    await fs.writeFile(
      file,
      `${[
        { type: 'session', id: `sidebar-search-${index}`, version: 3, timestamp, cwd: searchProject },
        {
          type: 'message',
          id: 'user',
          parentId: null,
          timestamp,
          message: {
            role: 'user',
            content: index === 34 ? '旧会话完整标题验收' : `搜索验收会话 ${index}`,
            timestamp: Date.parse(timestamp),
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n')}\n`,
    )
  }
  const preferences = () => evaluate('window.piMemeClient.getSettings().then(value => value.settings.sidebar)')
  const preferenceItem = async (submenu, item) => {
    await evaluate(
      `document.querySelector('[aria-label="侧边栏显示选项"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`,
    )
    await waitFor(() => evaluate('Boolean(document.querySelector("[role=menu]"))'), '侧栏显示菜单')
    await evaluate(
      `Array.from(document.querySelectorAll('[role="menuitem"]')).find(node => node.textContent.trim() === ${JSON.stringify(submenu)}).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`,
    )
    await waitFor(
      () =>
        evaluate(
          `Array.from(document.querySelectorAll('[role="menuitemradio"]')).some(node => node.textContent.trim() === ${JSON.stringify(item)})`,
        ),
      '侧栏选项子菜单',
    )
    assert.equal(
      await evaluate(
        `(() => { const items = [...document.querySelectorAll('[role="menuitemradio"]')]; return items.every(item => { const check = item.querySelector('svg.lucide-check'); const rect = item.getBoundingClientRect(); return !item.querySelector('svg.lucide-circle') && (item.getAttribute('aria-checked') === 'true' ? Boolean(check) && check.getBoundingClientRect().x > rect.x + rect.width / 2 : !check) }) && (${JSON.stringify(submenu)} !== '整理侧边栏' || items.every(item => Boolean(item.querySelector(item.textContent.trim() === '分项目显示' ? 'svg.lucide-folder' : 'svg.lucide-list')))); })()`,
      ),
      true,
    )
    const appearance = await evaluate('document.documentElement.dataset.appearance')
    await capture(`sidebar-${submenu === '整理侧边栏' ? 'grouping' : 'sorting'}-menu-${appearance}`)
    await evaluate(
      `Array.from(document.querySelectorAll('[role="menuitemradio"]')).find(node => node.textContent.trim() === ${JSON.stringify(item)}).click()`,
    )
    await waitFor(() => evaluate('!document.querySelector("[role=menu]")'), '显示选项已选择')
  }
  const searchInput = 'input[aria-label="搜索聊天标题"]'
  const searchKey = async (key, extra = '') => {
    await evaluate(
      `document.querySelector(${JSON.stringify(searchInput)}).dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true${extra} }))`,
    )
  }
  const inputSearch = async (value) => {
    await evaluate(
      `(() => { const input = document.querySelector(${JSON.stringify(searchInput)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
    )
  }
  const openSearch = async () => {
    await evaluate(
      `document.querySelector('[aria-label="搜索聊天"]').focus(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }))`,
    )
    await waitFor(
      () => evaluate(`document.activeElement === document.querySelector(${JSON.stringify(searchInput)})`),
      '搜索输入框聚焦',
    )
  }
  try {
    await evaluate(`window.piMemeClient.selectWorkspace({ kind: 'project', cwd: ${JSON.stringify(searchProject)} })`)
    await evaluate(`window.piMemeClient.selectWorkspace({ kind: 'project', cwd: ${JSON.stringify(other)} })`)
    await waitFor(
      () => evaluate(`Boolean(document.querySelector('[data-project-cwd="${searchProject}"]'))`),
      '完整搜索测试项目',
    )
    await preferenceItem('整理侧边栏', '合并显示')
    await waitFor(async () => (await preferences()).groupMode === 'merged', '合并模式保存')
    await checkSectionHover()
    assert.equal(
      await evaluate(
        `document.querySelector(${JSON.stringify(projectSelector)}).querySelector('button[aria-expanded]').getAttribute('aria-expanded')`,
      ),
      'true',
    )
    assert.equal(
      await evaluate(
        `document.querySelector('[data-sidebar-section="projects"] [data-project-cwd="${searchProject}"]').querySelector(':scope > button').getAttribute('aria-expanded') === null`,
      ),
      true,
    )
    await preferenceItem('聊天排序方式', '手动排序')
    await waitFor(async () => (await preferences()).sortMode === 'manual', '手动排序保存')
    await preferenceItem('整理侧边栏', '分项目显示')
    await waitFor(async () => (await preferences()).groupMode === 'projects', '项目分组保存')
    for (const section of ['pinned', 'projects', 'recents']) {
      const animation = await evaluate(
        `new Promise((resolve, reject) => { const watchdog = setTimeout(() => reject(new Error("侧栏 ${section} 折叠动画采样超过 2 秒")), 2000); const section = document.querySelector('[data-sidebar-section="${section}"]'); const button = section.querySelector('button[aria-controls]'); const content = document.getElementById(button.getAttribute('aria-controls')); const startHeight = content.getBoundingClientRect().height; const heights = []; const style = getComputedStyle(content); const duration = style.transitionDuration; const property = style.transitionProperty; button.click(); requestAnimationFrame(() => { const immediatelyInert = content.inert && content.getAttribute('aria-hidden') === 'true' && !content.hidden; const candidate = content.querySelector('button'); if (candidate) candidate.focus(); const focusExcluded = !content.contains(document.activeElement); const began = performance.now(); function sample() { const height = content.getBoundingClientRect().height; heights.push(height); if (performance.now() - began < 350) requestAnimationFrame(sample); else { clearTimeout(watchdog); resolve({ startHeight, heights, duration, property, immediatelyInert, focusExcluded, reducedMotion: content.classList.contains('motion-reduce:transition-none'), closed: content.dataset.sidebarCollapse === 'closed', gridZero: content.classList.contains('grid-rows-[0fr]') }); } } sample(); }); })`,
      )
      assert.equal(animation.immediatelyInert && animation.focusExcluded, true)
      assert.equal(animation.closed && animation.gridZero && animation.reducedMotion, true)
      assert.equal(
        animation.duration.split(',').some((duration) => Number.parseFloat(duration) > 0),
        true,
      )
      assert.match(animation.property, /grid-template-rows/)
      if (section !== 'recents') assert.equal(animation.startHeight > 0, true)
      if (animation.startHeight > 0)
        assert.equal(
          animation.heights.some((height) => height > 0 && height < animation.startHeight),
          true,
          `${section} 折叠包含中间高度`,
        )
      assert.equal(animation.heights.at(-1), 0)
      await waitFor(async () => (await preferences()).collapsed[section] === true, `${section} 折叠保存`)
    }
    window.webContents.reload()
    await waitFor(
      () =>
        evaluate(
          `Boolean(window.piMemeClient) && ['pinned', 'projects', 'recents'].every(id => document.querySelector('[data-sidebar-section="' + id + '"] button[aria-controls]')?.getAttribute('aria-expanded') === 'false')`,
        ),
      '页面重载侧栏恢复',
    )
    for (const section of ['pinned', 'projects', 'recents']) {
      assert.equal(
        await evaluate(
          `document.querySelector('[data-sidebar-section="${section}"] button[aria-expanded]').getAttribute('aria-expanded')`,
        ),
        'false',
      )
      await evaluate(`document.querySelector('[data-sidebar-section="${section}"] > div > button').click()`)
      await waitFor(async () => (await preferences()).collapsed[section] === false, `${section} 展开保存`)
    }
    await evaluate(
      `(() => { const button = document.querySelector(${JSON.stringify(projectSelector)}).querySelector('button[aria-expanded]'); if (button.getAttribute('aria-expanded') !== 'true') button.click(); })()`,
    )
    await waitFor(
      () =>
        evaluate(
          `document.querySelector(${JSON.stringify(projectSelector)}).querySelector('button[aria-expanded]').getAttribute('aria-expanded') === 'true'`,
        ),
      '重载后置顶项目可展开',
    )
    const firstSortable = `${sessionSelector}`
    const projectListKey = await evaluate(
      `'project:' + document.querySelector(${JSON.stringify(projectSelector)}).closest('[data-sidebar-item-key]').dataset.sidebarItemKey`,
    )
    const initialKeys = await evaluate(
      `Array.from(document.querySelector(${JSON.stringify(projectSelector)}).parentElement.parentElement.querySelectorAll('[data-sidebar-item-key]')).map(node => node.dataset.sidebarItemKey).filter(key => JSON.parse(key)[1] === 'session')`,
    )
    assert.equal(initialKeys.length, 2)
    await evaluate(
      `(() => { const row = document.querySelector(${JSON.stringify(firstSortable)}).closest('[data-sidebar-item-key]'); const handle = row.querySelector('[aria-label="拖动排序，方向键上下移动"]'); handle.focus(); handle.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(initialKeys[0].includes(files[0]) ? 'ArrowDown' : 'ArrowUp')}, bubbles: true, cancelable: true })); })()`,
    )
    const expectedKeyboardKeys = [...initialKeys].reverse()
    await waitFor(
      async () => JSON.stringify((await preferences()).orders[projectListKey]) === JSON.stringify(expectedKeyboardKeys),
      '键盘排序已保存',
    )
    const keyboardKeys = (await preferences()).orders[projectListKey]
    assert.notDeepEqual(keyboardKeys, initialKeys)
    await evaluate(
      `(() => { const rows = Array.from(document.querySelectorAll('[data-sidebar-item-key]')); const source = rows.find(node => node.dataset.sidebarItemKey === ${JSON.stringify(keyboardKeys[0])}); const target = rows.find(node => node.dataset.sidebarItemKey === ${JSON.stringify(keyboardKeys[1])}); const dataTransfer = new DataTransfer(); source.querySelector('[aria-label="拖动排序，方向键上下移动"]').dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer })); target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer })); target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer })); })()`,
    )
    await waitFor(
      async () => JSON.stringify((await preferences()).orders[projectListKey]) === JSON.stringify(initialKeys),
      '原生拖动排序已保存',
    )
    await capture('sidebar-controls-light')
    await openSearch()
    await inputSearch('搜索验收会话')
    await waitFor(() => evaluate('document.querySelectorAll("[role=option]").length === 34'), '完整标题搜索索引')
    const firstOption = await evaluate(
      `document.querySelector(${JSON.stringify(searchInput)}).getAttribute('aria-activedescendant')`,
    )
    await searchKey('ArrowDown')
    await waitFor(
      () =>
        evaluate(
          `document.querySelector(${JSON.stringify(searchInput)}).getAttribute('aria-activedescendant') !== ${JSON.stringify(firstOption)}`,
        ),
      '搜索向下选择',
    )
    await searchKey('ArrowUp')
    await waitFor(
      () =>
        evaluate(
          `document.querySelector(${JSON.stringify(searchInput)}).getAttribute('aria-activedescendant') === ${JSON.stringify(firstOption)}`,
        ),
      '搜索向上选择',
    )
    await inputSearch('旧会话完整标题验收')
    await waitFor(() => evaluate('document.querySelectorAll("[role=option]").length === 1'), '旧于30项的完整标题命中')
    await evaluate(
      `document.querySelector(${JSON.stringify(searchInput)}).dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))`,
    )
    await searchKey('Enter', ', isComposing: true')
    await searchKey('Escape', ', isComposing: true')
    assert.equal(await evaluate(`Boolean(document.querySelector(${JSON.stringify(searchInput)}))`), true)
    await evaluate(
      `document.querySelector(${JSON.stringify(searchInput)}).dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))`,
    )
    await capture('sidebar-search-light')
    await searchKey('Escape')
    await waitFor(() => evaluate('!document.querySelector("[role=dialog]")'), '搜索Esc关闭')
    await waitFor(
      () => evaluate('document.activeElement?.getAttribute("aria-label") === "搜索聊天"'),
      '搜索关闭恢复焦点',
    )
    await theme('dark')
    await preferenceItem('整理侧边栏', '分项目显示')
    await preferenceItem('聊天排序方式', '手动排序')
    await capture('sidebar-controls-dark')
    await openSearch()
    await inputSearch('旧会话完整标题验收')
    await waitFor(() => evaluate('document.querySelectorAll("[role=option]").length === 1'), '深色搜索结果')
    await capture('sidebar-search-dark')
    await searchKey('Enter')
    await waitFor(() => evaluate('!document.querySelector("[role=dialog]")'), '搜索Enter打开会话')
    await waitFor(
      () =>
        evaluate(
          `window.piMemeClient.getConnection().then(value => value.sessionFile === ${JSON.stringify(searchFiles[34])})`,
        ),
      '搜索选中原始会话',
    )
    await evaluate(`window.piMemeClient.selectWorkspace({ kind: 'project', cwd: ${JSON.stringify(other)} })`)
  } finally {
    await evaluate(`window.piMemeClient.selectWorkspace({ kind: 'project', cwd: ${JSON.stringify(other)} })`)
    await evaluate(`window.piMemeClient.saveSidebarPreferences(${JSON.stringify(originalSidebar)})`)
    await evaluate(
      `window.piMemeClient.removeProject(${JSON.stringify(searchProject)}, ${JSON.stringify(searchFiles)})`,
    )
    await fs.rm(searchProject, { recursive: true, force: true })
    await fs.rm(searchFolder, { recursive: true, force: true })
  }
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
