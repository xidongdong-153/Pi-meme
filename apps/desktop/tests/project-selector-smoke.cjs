const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { dialog } = require('electron')

module.exports = async function projectSelectorSmoke(window, waitFor, directory, screenshots) {
  const evaluate = (code) => window.webContents.executeJavaScript(code)
  const editor = '[contenteditable=true][aria-label="消息"]'
  const panel = '[aria-label="项目选择"]'
  const trigger = '[aria-label="选择当前项目"]'
  const idle = () => evaluate('window.piMemeClient.getConnection().then((value) => value.status === "idle")')
  const capture = async (name) => {
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    await fs.writeFile(path.join(screenshots, `${name}.png`), (await window.webContents.capturePage()).toPNG())
  }
  const theme = async (appearance) => {
    if (await evaluate(`Boolean(document.querySelector(${JSON.stringify(panel)}))`)) {
      await evaluate(
        `document.querySelector('[aria-label="搜索项目"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
      )
      await waitFor(() => evaluate(`!document.querySelector(${JSON.stringify(panel)})`), '关闭项目菜单后切换主题')
    }
    await evaluate(`document.querySelector('button[aria-label="设置"]').click()`)
    await evaluate(
      `Array.from(document.querySelectorAll('nav[aria-label="设置分类"] button')).find(node => node.textContent.trim() === '外观').click()`,
    )
    await evaluate(`document.querySelector('[aria-label="${appearance === 'dark' ? '深色' : '浅色'}模式"]').click()`)
    await evaluate(
      `document.querySelector('[role="combobox"][aria-label="外观主题"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`,
    )
    const label = appearance === 'dark' ? '深色' : '浅色'
    await waitFor(
      () =>
        evaluate(
          `Array.from(document.querySelectorAll('[role="option"]')).some(node => node.textContent.includes(${JSON.stringify(label)}))`,
        ),
      '主题选项',
    )
    await evaluate(
      `Array.from(document.querySelectorAll('[role="option"]')).find(node => node.textContent.includes(${JSON.stringify(label)})).click()`,
    )
    await waitFor(
      () => evaluate(`document.documentElement.dataset.appearance === ${JSON.stringify(appearance)}`),
      '主题已应用',
    )
    await evaluate(
      `Array.from(document.querySelectorAll('button')).find(node => node.textContent.trim() === '返回聊天').click()`,
    )
  }
  const setInput = (selector, value) =>
    evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (node.isContentEditable) node.textContent = ${JSON.stringify(value)};
    else Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, ${JSON.stringify(value)});
    node.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  const open = async () => {
    await evaluate(`document.querySelector(${JSON.stringify(trigger)}).click()`)
    await waitFor(() => evaluate(`Boolean(document.querySelector('${panel} [role="option"]'))`), '项目菜单已读取')
  }
  const first = path.join(directory, 'selector-a', '同名项目')
  const second = path.join(directory, 'selector-b', '同名项目')
  await fs.mkdir(first, { recursive: true })
  await fs.mkdir(second, { recursive: true })
  await evaluate(`window.piMemeClient.chooseDirectory(${JSON.stringify(first)})`)
  await evaluate(`window.piMemeClient.chooseDirectory(${JSON.stringify(second)})`)
  await waitFor(
    () => evaluate(`document.querySelector(${JSON.stringify(trigger)})?.textContent.includes('同名项目')`),
    '输入框显示项目名称',
  )
  await assert.rejects(
    evaluate(`window.piMemeClient.selectWorkspace({ kind: ['project'], cwd: ${JSON.stringify(first)} })`),
    /工作环境参数无效/,
  )
  await setInput(editor, '跨项目文字 @src/app.ts')
  await evaluate(`(() => {
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE9sAAAAASUVORK5CYII='), value => value.charCodeAt(0));
    const data = new DataTransfer(); data.items.add(new File([bytes], '截图.png', { type: 'image/png' }));
    document.querySelector(${JSON.stringify(editor)}).dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
  })()`)
  await waitFor(
    () => evaluate(`document.querySelectorAll('[aria-label="已附加图片"] img').length === 1`),
    '项目草稿含图片',
  )
  await theme('light')
  await open()
  assert.equal(await evaluate(`document.activeElement?.getAttribute('aria-label')`), '搜索项目')
  assert.equal(await evaluate(`document.querySelector('${panel} [role="option"]')?.title`), second)
  assert.equal(
    await evaluate(
      `document.querySelector('[role="option"][title=${JSON.stringify(first)}]').textContent.includes('selector-a')`,
    ),
    true,
  )
  assert.equal(
    await evaluate(
      `document.querySelector('[role="option"][title=${JSON.stringify(second)}]').textContent.includes('selector-b')`,
    ),
    true,
  )
  await capture('project-selector-light')
  await theme('dark')
  await open()
  await capture('project-selector-dark')
  await setInput('[aria-label="搜索项目"]', 'selector-a')
  await waitFor(() => evaluate(`document.querySelectorAll('${panel} [role="option"]').length === 1`), '按路径搜索项目')
  await evaluate(
    `document.querySelector('[aria-label="搜索项目"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }))`,
  )
  assert.equal(await evaluate('window.piMemeClient.getConnection().then(value => value.cwd)'), second)
  for (const key of ['ArrowDown', 'ArrowUp', 'Enter']) {
    await evaluate(
      `document.querySelector('[aria-label="搜索项目"]').dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }))`,
    )
    if (key !== 'Enter') {
      const activeIndex = key === 'ArrowDown' ? 1 : 0
      await waitFor(
        () =>
          evaluate(
            `document.querySelector('${panel} [data-project-index="${activeIndex}"]')?.classList.contains('bg-secondary/70')`,
          ),
        `方向键高亮项目选项：${activeIndex}`,
      )
    }
  }
  await waitFor(
    () => evaluate(`window.piMemeClient.getConnection().then(value => value.cwd === ${JSON.stringify(first)})`),
    '方向键与 Enter 选择项目',
  )
  await waitFor(() => evaluate(`!document.querySelector(${JSON.stringify(panel)})`), '键盘选择后关闭菜单')
  assert.equal(
    await evaluate(`document.querySelector(${JSON.stringify(editor)}).textContent`),
    '跨项目文字 @src/app.ts',
  )
  assert.equal(await idle(), true, '切换项目不启动运行时')
  assert.equal(await evaluate(`document.querySelectorAll('[aria-label="已附加图片"] img').length`), 1)
  await evaluate(`document.querySelector('[aria-label="移除图片"]').click()`)
  assert.equal(await evaluate(`document.activeElement?.getAttribute('aria-label')`), '消息')
  assert.equal(await evaluate(`document.body.textContent.includes('文件引用将按当前目录解析')`), true)

  await open()
  await setInput('[aria-label="搜索项目"]', '没有这样的项目')
  await waitFor(
    () => evaluate(`document.querySelector(${JSON.stringify(panel)})?.textContent.includes('未找到项目')`),
    '搜索空状态',
  )
  assert.equal(
    await evaluate(`document.querySelector(${JSON.stringify(panel)}).textContent.includes('新建项目')`),
    true,
  )
  await evaluate(
    `document.querySelector('[aria-label="搜索项目"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
  )
  await waitFor(() => evaluate(`!document.querySelector(${JSON.stringify(panel)})`), 'Esc 关闭项目菜单')
  assert.equal(await evaluate(`document.activeElement?.getAttribute('aria-label')`), '选择当前项目')

  await evaluate(`document.querySelector('[aria-label="在顶栏选择项目"]').click()`)
  await waitFor(() => evaluate(`Boolean(document.querySelector('${panel} [role="option"]'))`), '顶栏打开项目选择器')
  await evaluate(
    `document.querySelector('[aria-label="搜索项目"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
  )
  await waitFor(() => evaluate(`!document.querySelector(${JSON.stringify(panel)})`), '顶栏项目菜单关闭')
  assert.equal(await evaluate(`document.activeElement?.getAttribute('aria-label')`), '在顶栏选择项目')

  const originalDialog = dialog.showOpenDialog
  try {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
    await open()
    await evaluate(
      `Array.from(document.querySelectorAll('${panel} button')).find(node => node.textContent.trim() === '新建项目').click()`,
    )
    await waitFor(() => evaluate(`!document.querySelector(${JSON.stringify(trigger)}).disabled`), '取消目录选择')
    assert.equal(await evaluate('window.piMemeClient.getConnection().then(value => value.cwd)'), first)
    assert.equal(
      await evaluate(`document.querySelector(${JSON.stringify(editor)}).textContent`),
      '跨项目文字 @src/app.ts',
    )
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [second] })
    await evaluate(
      `Array.from(document.querySelectorAll('${panel} button')).find(node => node.textContent.trim() === '新建项目').click()`,
    )
    await waitFor(() => evaluate(`!document.querySelector(${JSON.stringify(panel)})`), '选择已有文件夹新建项目')
    assert.equal(await evaluate('window.piMemeClient.getConnection().then(value => value.cwd)'), second)
  } finally {
    dialog.showOpenDialog = originalDialog
  }

  const deleted = path.join(directory, 'selector-deleted')
  await fs.mkdir(deleted)
  await evaluate(`window.piMemeClient.chooseDirectory(${JSON.stringify(deleted)})`)
  await evaluate(`window.piMemeClient.chooseDirectory(${JSON.stringify(second)})`)
  await fs.rm(deleted, { recursive: true })
  await setInput(editor, '目录失败后保留草稿')
  const originalKey = await evaluate('window.piMemeClient.getConnection().then(value => value.sessionKey)')
  await open()
  await evaluate(`document.querySelector('[role="option"][title=${JSON.stringify(deleted)}]').click()`)
  await waitFor(
    () => evaluate(`document.querySelector('[role="alert"]')?.textContent.includes('目录不可用')`),
    '失效目录错误',
  )
  assert.equal(await evaluate('window.piMemeClient.getConnection().then(value => value.sessionKey)'), originalKey)
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(editor)}).textContent`), '目录失败后保留草稿')
  assert.equal(await idle(), true, '选择失效目录不启动运行时')
  await evaluate(
    `Array.from(document.querySelectorAll('${panel} button')).find(node => node.textContent.includes('不在项目中工作')).click()`,
  )
  await waitFor(
    () => evaluate(`window.piMemeClient.getConnection().then(value => value.workspaceKind === 'standalone')`),
    '切换到无项目会话',
  )
  await waitFor(() => evaluate(`!document.querySelector(${JSON.stringify(panel)})`), '无项目选择完成')
  const standalone = await evaluate('window.piMemeClient.getConnection().then(value => value.cwd)')
  assert.ok(standalone.startsWith(path.join(directory, 'standalone-workspaces') + path.sep))
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(editor)}).textContent`), '目录失败后保留草稿')
  assert.equal(await idle(), true, '切换项目不启动运行时')
  assert.equal(
    await evaluate(
      'window.piMemeClient.getProjects().then(projects => projects.some(value => value.cwd.includes("standalone-workspaces")))',
    ),
    false,
  )
  await capture('project-selector-standalone')
  await evaluate(`document.querySelector('[aria-label="发送消息"]').click()`)
  await waitFor(
    () => evaluate('window.piMemeClient.getConnection().then((value) => value.status !== "idle")'),
    '无项目首次发送启动运行时',
  )
  assert.equal(await evaluate('window.piMemeClient.getConnection().then((value) => value.cwd)'), standalone)
  await waitFor(
    () =>
      evaluate(
        `window.piMemeClient.getSessions().then(value => value.standaloneSessions.some(session => session.cwd === ${JSON.stringify(standalone)}))`,
      ),
    '独立会话进入未归属项目列表',
  )
  await waitFor(() => evaluate(`document.body.textContent.includes('未归属项目')`), '未归属项目侧栏')
  const key = await evaluate('window.piMemeClient.getConnection().then(value => value.sessionKey)')
  await evaluate(`window.piMemeClient.abort(${JSON.stringify(key)})`)
  await evaluate('window.piMemeClient.newSession()')
  const fresh = await evaluate('window.piMemeClient.getConnection().then(value => value.cwd)')
  assert.notEqual(fresh, standalone)
  await assert.rejects(
    evaluate(`window.piMemeClient.chooseDirectory(${JSON.stringify(path.dirname(standalone))})`),
    /请选择具体的无项目会话目录/,
  )
  await evaluate(`window.piMemeClient.chooseDirectory(${JSON.stringify(standalone)})`)
  assert.equal(await evaluate('window.piMemeClient.getConnection().then(value => value.workspaceKind)'), 'standalone')
  await evaluate(`window.piMemeClient.chooseDirectory(${JSON.stringify(fresh)})`)
  const bounds = window.getBounds()
  window.setSize(720, 540)
  await open()
  await waitFor(
    () =>
      evaluate(
        `(() => { const rect = document.querySelector(${JSON.stringify(panel)})?.getBoundingClientRect(); return rect && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight })()`,
      ),
    '窄窗口项目菜单完整显示',
  )
  const geometry = await evaluate(
    `(() => { const rect = document.querySelector(${JSON.stringify(panel)}).getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight } })()`,
  )
  assert.ok(
    geometry.left >= 0 && geometry.right <= geometry.width && geometry.top >= 0 && geometry.bottom <= geometry.height,
  )
  await capture('project-selector-narrow')
  window.setBounds(bounds)
  await evaluate(
    `document.querySelector('[aria-label="搜索项目"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
  )
}
