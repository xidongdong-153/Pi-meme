const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { dialog, nativeTheme } = require('electron')

module.exports = async function appearanceSmoke(window, waitFor, directory, screenshots) {
  const { evaluate, pressKey, capture } = require('./desktop-test-helpers.cjs').desktopTestHelpers(
    window,
    waitFor,
    screenshots,
  )
  const click = (label) => evaluate(`document.querySelector('button[aria-label="${label}"]').click()`)
  const clickText = (text) =>
    evaluate(
      `Array.from(document.querySelectorAll('button')).find(node => node.textContent.trim() === ${JSON.stringify(text)}).click()`,
    )
  const change = (label, value) =>
    evaluate(`(() => {
    const input = document.querySelector('input[aria-label="${label}"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(String(value))});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  const choose = async (label, text) => {
    await pressKey('Enter', `[role="combobox"][aria-label="${label}"]`)
    await waitFor(
      () =>
        evaluate(
          `Array.from(document.querySelectorAll('[role="option"]')).some(node => node.textContent === ${JSON.stringify(text)})`,
        ),
      `${label}选项`,
    )
    await evaluate(
      `Array.from(document.querySelectorAll('[role="option"]')).find(node => node.textContent === ${JSON.stringify(text)}).focus()`,
    )
    await pressKey('Enter')
    await waitFor(
      () =>
        evaluate(
          `document.querySelector('[role="combobox"][aria-label="${label}"]').getAttribute('aria-expanded') === 'false' && !document.querySelector('[role=listbox]') && document.activeElement === document.querySelector('[role="combobox"][aria-label="${label}"]')`,
        ),
      `${label}菜单关闭`,
    )
  }
  const css = (key) =>
    evaluate(`getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(key)}).trim()`)
  const saved = async (predicate) =>
    waitFor(
      async () => predicate(JSON.parse(await fs.readFile(path.join(directory, 'settings.json'), 'utf8')).appearance),
      '外观配置保存',
    )
  const escape = async (label) => {
    await pressKey('Escape')
    await waitFor(
      () =>
        evaluate(
          `!document.querySelector('[role=dialog], [role=listbox]') && document.activeElement === document.querySelector('button[aria-label="${label}"]')`,
        ),
      '颜色菜单退场并恢复焦点',
    )
  }
  const chooseFont = async (label) => {
    const trigger = `button[aria-label="${label}"]`
    await pressKey('Enter', trigger)
    await waitFor(
      () =>
        evaluate(
          `Boolean(document.querySelector('[role="listbox"][aria-label="${label}"]')) && document.activeElement === document.querySelector('[aria-label="搜索${label}"]')`,
        ),
      `${label}选择器打开并获得焦点`,
    )
    await evaluate(
      `Array.from(document.querySelector('[role="listbox"][aria-label="${label}"]').querySelectorAll('button')).find(node => node.textContent === '系统').focus()`,
    )
    await pressKey('Enter')
    await waitFor(
      () =>
        evaluate(
          `!document.querySelector('[role=listbox], [role=dialog]') && document.activeElement === document.querySelector(${JSON.stringify(trigger)})`,
        ),
      `${label}选择器关闭并恢复焦点`,
    )
  }
  assert.equal(await evaluate(`Boolean(document.querySelector('[aria-label="界面字号"]'))`), true)
  assert.equal(await evaluate(`document.querySelector('#settings-content select') === null`), true)
  assert.equal(
    await evaluate(`document.querySelector('[role="combobox"][aria-label="强调色"]').textContent`),
    '主题默认',
  )
  const spacing = await evaluate(`(() => {
    const trigger = document.querySelector('[role="combobox"][aria-label="强调色"]');
    const text = trigger.querySelector('span').getBoundingClientRect();
    const arrow = trigger.querySelector('svg').getBoundingClientRect();
    return { gap: arrow.left - text.right, right: trigger.getBoundingClientRect().right - arrow.right };
  })()`)
  assert.ok(spacing.gap >= 10 && spacing.right >= 10, '下拉文字与箭头、箭头与边缘保留间距')
  await capture('appearance-dark')
  await change('界面字号', 18)
  await waitFor(() => css('--text-ui').then((value) => value === '18px'), '界面字号预览')
  await change('代码字体大小', 17)
  await change('对比度', 100)
  const baseBackground = await css('--color-background')
  assert.equal(await css('--color-background'), baseBackground)
  await click('半透明侧边栏')
  await waitFor(() => evaluate(`document.documentElement.dataset.translucentSidebar === 'true'`), '半透明预览')
  assert.equal(
    await evaluate(`getComputedStyle(document.querySelector('.appearance-sidebar')).backdropFilter`),
    'blur(16px)',
  )
  await evaluate(
    `Array.from(document.querySelector('[role="group"][aria-label="减少动态效果"]').querySelectorAll('button')).find(node => node.textContent === '开启').click()`,
  )
  await waitFor(() => evaluate(`document.documentElement.dataset.reducedMotion === 'true'`), '减少动效')
  await choose('强调色', '蓝')
  await waitFor(() => css('--color-accent').then((value) => value === '#3b82f6'), '强调色预览')
  await choose('强调色', '主题默认')
  await saved((value) => !value.shared.colors?.accent)
  await choose('强调色', '蓝')
  await click('背景颜色')
  await change('背景 HEX', '#123456')
  await waitFor(() => css('--color-background').then((value) => value === '#123456'), 'HEX 实时预览')
  await change('背景 HEX', '#bad')
  assert.equal(await css('--color-background'), '#123456')
  assert.equal(await evaluate(`document.querySelector('[aria-label="背景 HEX"]').getAttribute('aria-invalid')`), 'true')
  await escape('背景颜色')
  await click('前景颜色')
  await change('前景 HEX', '#eeeeee')
  await waitFor(() => css('--color-text').then((value) => value === '#eeeeee'), '前景预览')
  await escape('前景颜色')
  await chooseFont('界面字体')
  await choose('界面字体样式', '粗体')
  await waitFor(() => css('--font-ui-weight').then((value) => value === '700'), '界面字体样式')
  await chooseFont('内容字体')
  await chooseFont('代码字体')
  await waitFor(() => css('--font-code').then((value) => value.includes('ui-monospace')), '系统代码字体')
  const codeElements = await evaluate(
    `Array.from(document.querySelectorAll('.pi-code-block-content, .pi-code-text, .cm-content')).map(node => getComputedStyle(node).fontSize)`,
  )
  assert.ok(codeElements.every((size) => size === '17px'))
  await choose('界面字体样式', '常规')
  await click('分别设置浅色和深色模式')
  await clickText('编辑浅色')
  await waitFor(() => evaluate(`document.documentElement.dataset.appearance === 'light'`), '独立浅色预览')
  await choose('强调色', '绿')
  await clickText('编辑深色')
  await waitFor(() => css('--color-accent').then((value) => value === '#3b82f6'), '深色覆盖值保留')
  await saved((value) => value.separate && value.light.colors.accent === '#22c55e' && value.codeSize === 17)
  await capture('appearance-advanced')

  const originalSource = nativeTheme.themeSource
  try {
    await click('分别设置浅色和深色模式')
    await click('系统模式')
    nativeTheme.themeSource = 'light'
    await waitFor(() => evaluate(`document.documentElement.dataset.appearance === 'light'`), '跟随系统浅色')
    nativeTheme.themeSource = 'dark'
    await waitFor(() => evaluate(`document.documentElement.dataset.appearance === 'dark'`), '跟随系统深色')
  } finally {
    nativeTheme.themeSource = originalSource
  }

  const importPath = path.join(directory, 'import-theme.json')
  const exportPath = path.join(directory, 'export-theme.json')
  await fs.writeFile(
    importPath,
    JSON.stringify({
      id: 'smoke-theme',
      name: '验收主题',
      appearance: 'dark',
      colors: { accent: '#abcdef' },
      fonts: { content: 'Georgia' },
      fontStyles: { content: 'italic' },
    }),
  )
  const originalOpen = dialog.showOpenDialog
  const originalSave = dialog.showSaveDialog
  try {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [importPath] })
    await click('导入主题')
    await waitFor(
      async () =>
        (await evaluate('window.piMemeClient.getSettings()')).themes.some((theme) => theme.id === 'smoke-theme'),
      '导入 JSON',
    )
    await click('深色模式')
    await pressKey('Enter', '[aria-label="外观主题"]')
    await waitFor(
      () =>
        evaluate(
          `Array.from(document.querySelectorAll('[role="option"]')).some(node => node.textContent === '验收主题')`,
        ),
      '导入主题选项',
    )
    await evaluate(
      `Array.from(document.querySelectorAll('[role="option"]')).find(node => node.textContent === '验收主题').click()`,
    )
    await waitFor(() => css('--color-accent').then((value) => value === '#abcdef'), '应用导入主题')
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: exportPath })
    await click('导出主题')
    await waitFor(
      async () =>
        fs
          .readFile(exportPath, 'utf8')
          .then(() => true)
          .catch(() => false),
      '导出 JSON',
    )
    const exported = JSON.parse(await fs.readFile(exportPath, 'utf8'))
    assert.equal(exported.colors.accent, '#abcdef')
    assert.equal(exported.fonts.content, 'Georgia')
    assert.equal(exported.fontStyles.content, 'italic')
    assert.equal(exported.uiSize, undefined)
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
    const before = await fs.readFile(path.join(directory, 'settings.json'), 'utf8')
    await click('导入主题')
    await evaluate('new Promise(resolve => setTimeout(resolve, 400))')
    assert.equal(await fs.readFile(path.join(directory, 'settings.json'), 'utf8'), before)
  } finally {
    dialog.showOpenDialog = originalOpen
    dialog.showSaveDialog = originalSave
  }

  window.setSize(720, 500)
  await capture('appearance-small')
  assert.equal(
    await evaluate(
      `document.querySelector('#settings-content').scrollWidth <= document.querySelector('#settings-content').clientWidth`,
    ),
    true,
  )
  await clickText('恢复外观默认值')
  await clickText('确认恢复')
  await saved((value) => value.uiSize === 14 && value.contrast === 50 && !value.separate && !value.translucentSidebar)
  window.setSize(1100, 760)
  await click('浅色模式')
  await saved((value) => value.mode === 'light')
  await waitFor(() => evaluate('Boolean(window.desktopSmokeFonts)'), '系统字体读取完成')
  const fontResult = await evaluate('window.desktopSmokeFonts')
  assert.equal(fontResult.error, undefined, fontResult.error)
  const installedFonts = await evaluate('window.piMemeClient.getInstalledFonts()')
  assert.ok(installedFonts.length > 0)
}
