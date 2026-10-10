const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { BrowserWindow } = require('electron')

module.exports = async function sessionSwitchSmoke(url, waitFor) {
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    webPreferences: {
      preload: path.resolve(__dirname, '..', '..', '..', 'tests', 'fixtures', 'session-switch-preload.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  })
  const evaluate = (code) =>
    window.webContents.executeJavaScript(code).catch((cause) => {
      throw new Error(`会话切换验收脚本执行失败：${code}`, { cause })
    })
  const clickSession = (name) =>
    evaluate(`document.querySelector('aside [title="${name}"] > button:first-child').click()`)
  const pending = (name) =>
    waitFor(() => evaluate(`window.sessionSwitchTest.status().pending === '${name}'`), `后台切换 ${name}`)
  const ready = (name) =>
    waitFor(
      () =>
        evaluate(
          `document.querySelector('[aria-label="对话消息流"]')?.textContent.includes('会话正文 ${name}') && document.querySelector('[contenteditable=true][aria-label="消息"]')?.isContentEditable`,
        ),
      `会话就绪 ${name}`,
    )
  const checkUsage = async (percent) => {
    await waitFor(
      () => evaluate(`Boolean(document.querySelector('[aria-label="背景信息窗口占用"]'))`),
      '模型插件上下文统计贡献加载完成',
    )
    const offset = await evaluate(
      `document.querySelector('[aria-label="背景信息窗口占用"] circle[stroke-dashoffset]')?.getAttribute('stroke-dashoffset')`,
    )
    if (percent === 0) assert.equal(offset, undefined)
    else assert.ok(Math.abs(Number(offset) - 2 * Math.PI * 6.8 * (1 - percent / 100)) < 0.001)
  }
  try {
    await window.loadURL(`${url}${url.includes('?') ? '&' : '?'}test-fixture=session-switch`)
    await ready('initial')
    await checkUsage(10)
    for (let count = 0; count < 2; count++) {
      await evaluate(`document.querySelector('aside [title="/other"] > button:first-child').click()`)
      assert.equal(await evaluate('window.piMemeTestBridge.getConnection().then((value) => value.cwd)'), '/test')
      assert.deepEqual(await evaluate('window.sessionSwitchTest.status().calls'), [])
      await ready('initial')
    }
    await evaluate('window.sessionSwitchTest.startAgent()')
    await waitFor(
      () => evaluate(`Boolean(document.querySelector('aside [title="initial"] [aria-label="会话运行中"]'))`),
      '当前会话运行图标',
    )
    await clickSession('b')
    await pending('b')
    await evaluate('window.sessionSwitchTest.finish()')
    await ready('b')
    assert.equal(
      await evaluate(`Boolean(document.querySelector('aside [title="initial"] [aria-label="会话运行中"]'))`),
      true,
    )
    await evaluate('window.sessionSwitchTest.startAgent()')
    await waitFor(
      () => evaluate(`document.querySelectorAll('aside [aria-label="会话运行中"]').length === 2`),
      '两个会话同时运行',
    )
    await evaluate("window.sessionSwitchTest.finishAgent('initial')")
    await waitFor(
      () => evaluate(`document.querySelectorAll('aside [aria-label="会话运行中"]').length === 1`),
      '后台任务结束实时移除图标',
    )
    assert.equal(await evaluate(`Boolean(document.querySelector('aside [title="b"] [aria-label="会话运行中"]'))`), true)
    await evaluate("window.sessionSwitchTest.finishAgent('b')")
    await waitFor(
      () => evaluate(`document.querySelectorAll('aside [aria-label="会话运行中"]').length === 0`),
      '全部任务结束',
    )
    await checkUsage(30)
    await clickSession('a')
    await pending('a')
    await clickSession('b')
    await waitFor(
      () => evaluate(`document.querySelector('[aria-label="对话消息流"]')?.textContent.includes('会话正文 b')`),
      '快速预览 b',
    )
    await clickSession('c')
    await waitFor(
      () => evaluate(`document.querySelector('[aria-label="对话消息流"]')?.textContent.includes('会话正文 c')`),
      '快速预览 c',
    )
    assert.equal(await evaluate('Boolean(document.querySelector("[role=alert]"))'), false)
    assert.deepEqual(await evaluate('window.sessionSwitchTest.status().calls'), ['b', 'a', 'b', 'c'])
    await checkUsage(0)
    await pending('c')
    await evaluate('window.sessionSwitchTest.finish()')
    await ready('c')
    await evaluate('window.sessionSwitchTest.finishStale()')
    await ready('c')
    assert.deepEqual(await evaluate('window.sessionSwitchTest.status().calls'), ['b', 'a', 'b', 'c'])
    await checkUsage(40)
    assert.equal(await evaluate('Boolean(document.querySelector("[role=alert]"))'), false)

    await clickSession('a')
    await pending('a')
    await clickSession('b')
    await waitFor(
      () => evaluate(`document.querySelector('[aria-label="对话消息流"]')?.textContent.includes('会话正文 b')`),
      '再次预览 b',
    )
    await clickSession('a')
    await waitFor(
      () => evaluate(`document.querySelector('[aria-label="对话消息流"]')?.textContent.includes('会话正文 a')`),
      '快速切回 a',
    )
    await pending('a')
    await evaluate('window.sessionSwitchTest.finish()')
    await ready('a')
    await evaluate('window.sessionSwitchTest.finishStale()')
    await ready('a')
    await checkUsage(20)
    assert.deepEqual(await evaluate('window.sessionSwitchTest.status().calls'), ['b', 'a', 'b', 'c', 'a', 'b', 'a'])
    await clickSession('c')
    await pending('c')
    await evaluate('window.sessionSwitchTest.finish()')
    await ready('c')

    for (const name of ['cancelled', 'failed']) {
      await clickSession(name)
      await pending(name)
      await evaluate('window.sessionSwitchTest.finish()')
      await ready('c')
      await checkUsage(40)
      assert.equal(
        await evaluate(`document.querySelector('aside [title="c"]').classList.contains('font-medium')`),
        true,
      )
    }
    await evaluate(
      `Array.from(document.querySelectorAll('aside button')).find((button) => button.textContent === '加载更多')?.click()`,
    )
    await clickSession('failed-after-select')
    await pending('failed-after-select')
    await evaluate('window.sessionSwitchTest.finish()')
    await pending('c')
    await evaluate('window.sessionSwitchTest.finish()')
    await ready('c')
    await checkUsage(40)
    await clickSession('no-stats')
    await pending('no-stats')
    await evaluate('window.sessionSwitchTest.finish()')
    await ready('no-stats')
    await checkUsage(0)
    for (const width of [720, 900, 1100, 1440]) {
      window.setSize(width, 760)
      await clickSession('wide')
      await pending('wide')
      await waitFor(
        () => evaluate(`document.querySelector('[aria-label="对话消息流"]')?.textContent.includes('长路径：')`),
        `长内容预览 ${width}`,
      )
      const layout = await evaluate(`(() => {
        const flow = document.querySelector('[aria-label="对话消息流"]');
        const code = flow.querySelector('.pi-code-block-content.overflow-x-auto');
        return {
          overflowX: getComputedStyle(flow).overflowX,
          width: flow.clientWidth,
          scrollWidth: flow.scrollWidth,
          codeWidth: code.clientWidth,
          codeScrollWidth: code.scrollWidth,
        };
      })()`)
      assert.equal(layout.overflowX, 'hidden', `消息区隐藏横向滚动条：${width}`)
      assert.ok(layout.scrollWidth <= layout.width + 1, `长文本不撑宽消息区：${width}`)
      assert.ok(layout.codeScrollWidth > layout.codeWidth, `代码块保留内部横向滚动：${width}`)
      await evaluate('window.sessionSwitchTest.finish()')
      await ready('wide')
      await clickSession('c')
      await pending('c')
      await evaluate('window.sessionSwitchTest.finish()')
      await ready('c')
    }
    const generation = await evaluate('window.sessionSwitchTest.status().connection.generation')
    await evaluate(`document.querySelector('aside [title="/test"] [aria-label^="在项目中新建会话："]').click()`)
    await waitFor(() => evaluate(`document.querySelector('h1')?.textContent === '开始一个新任务'`), '同项目新会话')
    assert.ok(await evaluate(`window.sessionSwitchTest.status().connection.generation > ${generation}`))
    const blankGeneration = await evaluate('window.sessionSwitchTest.status().connection.generation')
    await evaluate(`document.querySelector('aside [title="/test"] [aria-label^="在项目中新建会话："]').click()`)
    assert.equal(await evaluate('window.sessionSwitchTest.status().connection.generation'), blankGeneration)
    await evaluate(`document.querySelector('aside [title="/other"] [aria-label^="在项目中新建会话："]').click()`)
    await waitFor(() => evaluate(`window.sessionSwitchTest.status().connection.status === 'idle'`), '跨项目空白会话')
    assert.equal(await evaluate(`document.querySelector('h1')?.textContent`), '开始一个新任务')
    assert.equal(await evaluate(`document.querySelector('[aria-label="消息"]')?.isContentEditable`), true)
    await evaluate(`(() => {
      const editor = document.querySelector('[aria-label="消息"]');
      editor.focus();
      document.execCommand('insertText', false, '空白会话的草稿');
    })()`)
    await waitFor(
      () => evaluate(`document.querySelector('[aria-label="发送消息"]')?.disabled === false`),
      '新项目可以编辑并保留草稿',
    )
    assert.ok(await evaluate(`document.querySelector('[aria-label="消息"]').textContent.includes('空白会话的草稿')`))

    await evaluate(
      `Array.from(document.querySelectorAll('aside button')).find((button) => button.textContent === '加载更多')?.click()`,
    )
    await clickSession('slow-history')
    await pending('slow-history')
    await evaluate('window.sessionSwitchTest.finish()')
    await ready('slow-history')
    await evaluate('window.sessionSwitchTest.finishHistory()')
    await evaluate('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    await ready('slow-history')
    assert.equal(
      await evaluate(`document.querySelector('[aria-label="对话消息流"]').textContent.includes('本地过期预览')`),
      false,
    )

    await fs.writeFile(
      path.join(__dirname, '../out/desktop-smoke/session-switch.png'),
      (await window.webContents.capturePage()).toPNG(),
    )
    console.log(
      '会话切换验收通过：跨项目保留输入与草稿、同项目复用连接、慢历史与迟到预览、连续点击、最后一次选择、上下文统计、取消与失败恢复、缺少统计、多种窗口宽度与长内容',
    )
  } finally {
    window.destroy()
  }
}

if (process.env.PI_DESKTOP_SESSION_SWITCH_SMOKE === '1') {
  const { app } = require('electron')
  app.on('window-all-closed', () => {})
  ;(async () => {
    const directory = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'pi-session-switch-'))
    app.setPath('userData', directory)
    await app.whenReady()
    let failed = false
    try {
      await module.exports(
        require('node:url').pathToFileURL(path.join(__dirname, '../.vite/renderer/main_window/index.html')).href,
        async (check, label) => {
          const deadline = Date.now() + 10000
          while (Date.now() < deadline) {
            if (await check()) return
            await new Promise((resolve) => setTimeout(resolve, 50))
          }
          throw new Error(`会话切换验收等待超时：${label}`)
        },
      )
    } catch (error) {
      failed = true
      console.error(error)
    } finally {
      try {
        await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      } finally {
        app.exit(failed ? 1 : 0)
      }
    }
  })()
}
