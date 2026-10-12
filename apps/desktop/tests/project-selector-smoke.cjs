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
  const cardGeometry = await evaluate(`(() => {
    const node = document.querySelector('[data-testid="workspace-card"]');
    const card = node.getBoundingClientRect();
    const composer = document.querySelector('form[aria-label="消息输入"]').getBoundingClientRect();
    const projectButton = node.querySelector('[aria-label="选择当前项目"]');
    const project = projectButton.getBoundingClientRect();
    const chevron = projectButton.querySelector('.lucide-chevron-down').getBoundingClientRect();
    const location = node.querySelector('[aria-label="工作位置"]')?.getBoundingClientRect();
    const git = node.querySelector('[aria-label="Git 分支与工作树"]');
    const gitBounds = git.getBoundingClientRect();
    return {
      height: card.height, left: card.left - composer.left, right: composer.right - card.right,
      overlap: card.bottom - composer.top,
      projectWidth: project.width,
      projectHeight: project.height,
      chevronInset: project.right - chevron.right,
      location: location ? { width: location.width, gap: location.left - project.right } : null,
      git: { text: git.textContent.trim(), icons: git.querySelectorAll('svg').length, settings: Boolean(git.querySelector('.lucide-settings')), width: gitBounds.width, right: card.right - gitBounds.right },
      close: Boolean(node.querySelector('[aria-label="不在项目中工作"], .lucide-x')),
      nested: Boolean(document.querySelector('form[aria-label="消息输入"] [aria-label="选择当前项目"]')),
    };
  })()`)
  assert.equal(cardGeometry.height, 48)
  assert.equal(cardGeometry.left, 12)
  assert.equal(cardGeometry.right, 12)
  assert.equal(cardGeometry.overlap, 8, '工作插槽与输入框重叠连接')
  assert.ok(cardGeometry.projectWidth < 160, '短项目名称按内容收缩，不保留固定宽度')
  assert.equal(cardGeometry.projectHeight, 28, '项目入口与设置按钮等高')
  assert.equal(cardGeometry.chevronInset, 8, '下拉图标右侧只保留按钮内边距')
  assert.ok(cardGeometry.location, '工作插槽显示工作位置')
  assert.ok(cardGeometry.location.width < 140, '本机工作位置按内容收缩')
  assert.equal(cardGeometry.location.gap, 4, '项目与工作位置紧邻')
  assert.equal(cardGeometry.git.text, '', 'Git 设置入口不显示分支文字')
  assert.equal(cardGeometry.git.icons, 1, 'Git 设置入口只显示一个图标')
  assert.equal(cardGeometry.git.settings, true, 'Git 设置入口使用设置图标')
  assert.equal(cardGeometry.git.width, 28, 'Git 设置入口保持图标按钮尺寸')
  assert.ok(cardGeometry.git.right <= 12, 'Git 设置入口位于插槽最右侧')
  assert.equal(cardGeometry.close, false, '项目入口不显示独立关闭按钮')
  assert.equal(cardGeometry.nested, false)
  for (const [label, name] of [
    ['选择当前项目', 'project'],
    ['工作位置', 'location'],
    ['Git 分支与工作树', 'git'],
  ]) {
    const selector = `[data-testid="workspace-card"] [aria-label="${label}"]`
    const before = await evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      const rect = node.getBoundingClientRect();
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2), width: rect.width, background: getComputedStyle(node).backgroundColor };
    })()`)
    window.webContents.sendInputEvent({ type: 'mouseMove', x: before.x, y: before.y })
    await waitFor(
      () =>
        evaluate(`(() => {
          const node = document.querySelector(${JSON.stringify(selector)});
          return node.matches(':hover') && getComputedStyle(node).backgroundColor !== ${JSON.stringify(before.background)};
        })()`),
      `${label}悬停高亮`,
    )
    assert.equal(
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().width`),
      before.width,
      `${label}悬停不改变宽度`,
    )
    await capture(`project-workspace-hover-${name}`)
  }
  window.webContents.sendInputEvent({ type: 'mouseMove', x: 0, y: 0 })
  await theme('light')
  await open()
  assert.equal(
    await evaluate(
      `Array.from(document.querySelectorAll('${panel} button')).some(node => node.textContent.trim() === '不在项目中工作')`,
    ),
    true,
    '无项目工作选项保留在项目菜单中',
  )
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
  await waitFor(
    () => evaluate(`!document.querySelector('[data-testid="workspace-card"]')?.getBoundingClientRect().width`),
    '首次发送后隐藏工作插槽',
  )
  assert.equal(await evaluate('window.piMemeClient.getConnection().then((value) => value.cwd)'), standalone)
  await waitFor(
    () =>
      evaluate(
        `window.piMemeClient.getSessions().then(value => value.standaloneSessions.some(session => session.cwd === ${JSON.stringify(standalone)}))`,
      ),
    '独立会话进入Host无项目会话列表',
  )
  await waitFor(
    () =>
      evaluate(`window.piMemeClient.getSessions().then(value => {
        const session = value.standaloneSessions.find(entry => entry.cwd === ${JSON.stringify(standalone)})
        return Boolean(session && [...document.querySelectorAll('#workspace-sidebar [data-session-path]')]
          .some(node => node.dataset.sessionPath === session.path && node.checkVisibility()))
      })`),
    '无项目会话在最近侧栏中可见',
  )
  const key = await evaluate('window.piMemeClient.getConnection().then(value => value.sessionKey)')
  await evaluate(`window.piMemeClient.abort(${JSON.stringify(key)})`)
  await waitFor(
    () => evaluate(`!document.querySelector('[aria-label="在顶栏选择项目"]').disabled`),
    '停止后顶栏项目入口可操作',
  )
  await evaluate(`document.querySelector('[aria-label="在顶栏选择项目"]').click()`)
  await waitFor(
    () => evaluate(`Boolean(document.querySelector('${panel} [role="option"]'))`),
    '已有会话从顶栏打开项目菜单',
  )
  const headerMenu = await evaluate(`(() => {
    const menu = document.querySelector(${JSON.stringify(panel)}).getBoundingClientRect();
    const button = document.querySelector('[aria-label="在顶栏选择项目"]').getBoundingClientRect();
    return { top: menu.top, left: menu.left, right: menu.right, buttonBottom: button.bottom, buttonLeft: button.left, buttonRight: button.right };
  })()`)
  assert.ok(headerMenu.top >= headerMenu.buttonBottom, '已有会话项目菜单位于顶栏入口下方')
  assert.ok(
    headerMenu.left <= headerMenu.buttonRight && headerMenu.right >= headerMenu.buttonLeft,
    '已有会话项目菜单与顶栏入口水平相交',
  )
  assert.equal(
    await evaluate(`Boolean(document.querySelector('[data-testid="workspace-card"]')?.getBoundingClientRect().width)`),
    false,
  )
  await evaluate(
    `document.querySelector('[aria-label="搜索项目"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
  )
  await waitFor(() => evaluate(`!document.querySelector(${JSON.stringify(panel)})`), '已有会话顶栏项目菜单关闭')
  assert.equal(await evaluate(`document.activeElement?.getAttribute('aria-label')`), '在顶栏选择项目')
  await evaluate('window.piMemeClient.newSession()')
  await waitFor(
    () => evaluate(`Boolean(document.querySelector('[data-testid="workspace-card"]')?.getBoundingClientRect().width)`),
    '新建未开始会话恢复工作插槽',
  )
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
