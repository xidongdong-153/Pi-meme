const assert = require('node:assert/strict')
const path = require('node:path')
const { BrowserWindow } = require('electron')

module.exports = async function multiServiceSmoke(url, waitFor) {
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    webPreferences: {
      preload: path.resolve(__dirname, '../../../tests/fixtures/multi-service-preload.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  })
  window.setAlwaysOnTop(true)
  const { evaluate } = require('./desktop-test-helpers.cjs').desktopTestHelpers(window, waitFor)
  window.webContents.setBackgroundThrottling(false)
  const editor = '[contenteditable=true][aria-label="消息"]'
  const setDraft = (text) =>
    evaluate(
      `(() => { const node = document.querySelector(${JSON.stringify(editor)}); node.textContent = ${JSON.stringify(text)}; node.focus(); const range = document.createRange(); range.selectNodeContents(node); range.collapse(false); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); node.dispatchEvent(new Event('input', { bubbles: true })); })()`,
    )
  const clickText = (text, root = 'body') =>
    evaluate(
      `Array.from(document.querySelector(${JSON.stringify(root)}).querySelectorAll('button')).find(node => node.textContent.trim() === ${JSON.stringify(text)}).click()`,
    )
  const location = async (id) => {
    assert.equal(
      await evaluate(`Boolean(document.querySelector('[aria-label="工作位置"]')?.getBoundingClientRect().width)`),
      true,
      '从可见的新聊天工作插槽打开工作位置菜单',
    )
    await evaluate(`document.querySelector('[aria-label="工作位置"]').click()`)
    await waitFor(() => evaluate(`Boolean(document.querySelector('[aria-label="选择工作位置"]'))`), '工作位置菜单')
    assert.equal(
      await evaluate(`document.querySelector('[aria-label="选择工作位置"]').textContent.includes('同名项目')`),
      false,
    )
    await clickText(id === 'local' ? '此计算机' : 'remote.example.com:8443', '[aria-label="选择工作位置"]')
    await waitFor(
      () => evaluate(`Boolean(document.querySelector('[aria-label="搜索工作位置项目"]'))`),
      '所属服务项目列表',
    )
    assert.equal(
      await evaluate(`document.querySelector('[role="dialog"][data-state="open"] h2')?.textContent === '切换工作位置'`),
      false,
    )
    await evaluate(`document.querySelector('[aria-label="返回工作位置服务列表"]').click()`)
    await waitFor(
      () => evaluate(`Boolean(document.querySelector('[aria-label="搜索工作位置服务"]'))`),
      '返回工作位置服务列表',
    )
    assert.equal(
      await evaluate(`document.querySelector('[aria-label="选择工作位置"]').textContent.includes('同名项目')`),
      false,
    )
    await clickText(id === 'local' ? '此计算机' : 'remote.example.com:8443', '[aria-label="选择工作位置"]')
    await waitFor(
      () => evaluate(`Boolean(document.querySelector('[aria-label="搜索工作位置项目"]'))`),
      '返回后再次选择服务',
    )
    await clickText('同名项目', '[aria-label="选择工作位置"]')
    await waitFor(
      () => evaluate(`document.querySelector('[role="dialog"][data-state="open"] h2')?.textContent === '切换工作位置'`),
      '工作位置确认',
    )
  }
  const assertDraft = async (text, images, plan) => {
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(editor)}).textContent`), text)
    assert.equal(await evaluate(`document.querySelectorAll('[aria-label="已附加图片"] img').length`), images)
    assert.equal(await evaluate(`Boolean(document.querySelector('[aria-label="关闭计划模式"]'))`), plan)
  }
  const newChat = async () => {
    await clickText('新聊天')
    await waitFor(
      () =>
        evaluate(`Boolean(document.querySelector('[data-testid="workspace-card"]')?.getBoundingClientRect().width)`),
      '新聊天显示工作插槽',
    )
  }
  const pressKey = (keyCode, modifiers = []) => {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  }
  const openSearch = async (modifier) => {
    pressKey('K', [modifier])
    await waitFor(
      () => evaluate(`document.activeElement?.getAttribute('aria-label') === '搜索聊天标题'`),
      '快捷键打开并聚焦跨服务聊天搜索',
    )
    assert.equal(await evaluate(`document.querySelectorAll('[aria-label="搜索聊天标题"]').length`), 1)
  }
  const selectedSearchTitle = () =>
    evaluate(`document.querySelector('[aria-label="聊天搜索结果"] [aria-selected="true"] [title]')?.title`)
  const assertHiddenSearchInactive = async () => {
    await evaluate(`document.querySelector('[aria-label="设置"]').click()`)
    await waitFor(() => evaluate(`Boolean(document.querySelector('[aria-label="设置页面"]'))`), '当前服务设置页面')
    for (const modifier of ['meta', 'control']) {
      pressKey('K', [modifier])
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      assert.equal(
        await evaluate(`Boolean(document.querySelector('[aria-label="搜索聊天标题"]'))`),
        false,
        `当前服务设置页面中，隐藏 App 不接管 ${modifier === 'meta' ? 'Cmd' : 'Ctrl'}+K`,
      )
    }
    await clickText('返回聊天', '[aria-label="设置页面"]')
    await waitFor(() => evaluate(`!document.querySelector('[aria-label="设置页面"]')`), '返回当前服务聊天')
  }
  try {
    await window.loadURL(`${url}${url.includes('?') ? '&' : '?'}test-fixture=multi-service`)
    await waitFor(
      () => evaluate(`document.querySelector('main[data-active-service="local"] ${editor}')?.isContentEditable`),
      '多服务初始界面',
    )
    await waitFor(
      () => evaluate(`document.querySelectorAll('[data-project-cwd="/same"]').length === 2`),
      '同名同路径项目按服务隔离',
    )
    await newChat()
    const sourceKey = await evaluate('window.multiServiceTest.local.status().connection.sessionKey')
    await setDraft('/plan')
    await waitFor(() => evaluate(`Boolean(document.querySelector('[aria-label="斜杠命令"]'))`), '计划命令补全')
    await evaluate(
      `document.querySelector(${JSON.stringify(editor)}).dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))`,
    )
    await waitFor(() => evaluate(`Boolean(document.querySelector('[aria-label="关闭计划模式"]'))`), '计划模式')
    await setDraft('跨服务文字草稿')
    await evaluate(
      `(() => { const data = new DataTransfer(); data.items.add(new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE9sAAAAASUVORK5CYII='), char => char.charCodeAt(0))], '截图.png', { type: 'image/png' })); document.querySelector(${JSON.stringify(editor)}).dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true })); })()`,
    )
    await waitFor(
      () => evaluate(`document.querySelectorAll('[aria-label="已附加图片"] img').length === 1`),
      '跨服务图片草稿',
    )
    await location('remote')
    await clickText('取消', '[role="dialog"][data-state="open"]')
    assert.equal(await evaluate(`document.querySelector('main').dataset.activeService`), 'local')
    assert.equal(await evaluate('window.multiServiceTest.remote.status().count'), 0)
    await assertDraft('跨服务文字草稿', 1, true)
    await location('remote')
    await clickText('确认切换', '[role="dialog"][data-state="open"]')
    await waitFor(
      () =>
        evaluate(
          `document.querySelector('main').dataset.activeService === 'remote' && document.querySelector('[aria-label="关闭计划模式"]')`,
        ),
      '远程新对话迁移',
    )
    await assertDraft('跨服务文字草稿', 1, true)
    assert.equal(await evaluate('window.multiServiceTest.remote.status().count'), 1)
    assert.equal(await evaluate('window.multiServiceTest.remote.status().mode'), 'plan')
    assert.equal(await evaluate('window.multiServiceTest.local.status().connection.sessionKey'), sourceKey)
    await evaluate(`document.querySelector('[data-service-id="local"] [data-project-cwd="/same"] > button').click()`)
    await evaluate(
      `Array.from(document.querySelectorAll('[data-service-id="local"] button')).find(node => node.title === 'local旧对话' || node.closest('[title="local旧对话"]')).click()`,
    )
    await waitFor(() => evaluate(`document.querySelector('main').dataset.activeService === 'local'`), '恢复本机旧对话')
    await assertDraft('', 0, false)
    assert.equal(
      await evaluate(
        `Boolean(document.querySelector('[data-testid="workspace-card"]')?.getBoundingClientRect().width)`,
      ),
      false,
      '本机已有会话隐藏工作插槽',
    )
    await newChat()
    await setDraft('本机独立草稿')
    await location('remote')
    await clickText('取消', '[role="dialog"][data-state="open"]')
    await assertDraft('本机独立草稿', 0, false)
    await evaluate('window.multiServiceTest.remote.delayCommands()')
    await location('remote')
    await clickText('确认切换', '[role="dialog"][data-state="open"]')
    await waitFor(() => evaluate('window.multiServiceTest.remote.status().pendingCommands'), '远程技能读取延迟')
    await setDraft('等待远程期间追加的文字')
    await evaluate(
      `(() => { const data = new DataTransfer(); data.items.add(new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE9sAAAAASUVORK5CYII='), char => char.charCodeAt(0))], '等待时截图.png', { type: 'image/png' })); document.querySelector(${JSON.stringify(editor)}).dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true })); })()`,
    )
    await waitFor(
      () => evaluate(`document.querySelectorAll('[aria-label="已附加图片"] img').length === 1`),
      '等待期间追加图片',
    )
    const waitingKey = await evaluate('window.multiServiceTest.local.status().connection.sessionKey')
    await evaluate('window.multiServiceTest.remote.releaseCommands()')
    await waitFor(
      () => evaluate(`document.querySelector('main').dataset.activeService === 'remote'`),
      '延迟完成后切换远程',
    )
    await assertDraft('本机独立草稿', 0, false)
    await evaluate(
      `document.querySelector('[data-service-id="local"] [aria-label="在项目中新建会话：同名项目"]').click()`,
    )
    assert.equal(
      await evaluate('window.multiServiceTest.local.status().connection.sessionKey'),
      waitingKey,
      '项目新会话入口复用未发送的本机聊天身份',
    )
    await waitFor(
      () => evaluate(`document.querySelector('main').dataset.activeService === 'local'`),
      '恢复等待期间的本机草稿',
    )
    await assertDraft('等待远程期间追加的文字', 1, false)
    await evaluate('window.multiServiceTest.remote.emit("远程后台事件")')
    assert.equal(
      await evaluate(
        `document.querySelector('[aria-label="对话消息流"]')?.textContent.includes('远程后台事件') ?? false`,
      ),
      false,
    )
    const localBeforeSearch = await evaluate('window.multiServiceTest.local.status()')
    const remoteBeforeSearch = await evaluate('window.multiServiceTest.remote.status()')
    await openSearch('meta')
    await window.webContents.insertText('旧对话')
    await waitFor(
      () => evaluate(`document.querySelectorAll('[aria-label="聊天搜索结果"] [role="option"]').length === 2`),
      '相同会话路径保留本机与远程两个搜索结果',
    )
    assert.equal(await selectedSearchTitle(), 'local旧对话')
    assert.equal(
      await evaluate(
        `Array.from(document.querySelectorAll('[aria-label="聊天搜索结果"] [role="option"]')).find(node => node.querySelector('[title]')?.title === 'remote旧对话')?.textContent.includes('同名项目 · remote.example.com:8443')`,
      ),
      true,
      '远程搜索结果显示所属服务地址',
    )
    assert.equal(
      await evaluate(
        `Array.from(document.querySelectorAll('[aria-label="聊天搜索结果"] [role="option"]')).find(node => node.querySelector('[title]')?.title === 'local旧对话')?.textContent.includes('remote.example.com:8443')`,
      ),
      false,
      '本机搜索结果不显示远程服务标签',
    )
    pressKey('Down')
    await waitFor(async () => (await selectedSearchTitle()) === 'remote旧对话', '下方向键选择远程结果')
    pressKey('Up')
    await waitFor(async () => (await selectedSearchTitle()) === 'local旧对话', '上方向键返回本机结果')
    pressKey('Down')
    await waitFor(async () => (await selectedSearchTitle()) === 'remote旧对话', '再次选择远程结果')
    pressKey('Enter')
    await waitFor(
      () =>
        evaluate(
          `document.querySelector('main').dataset.activeService === 'remote' && !document.querySelector('[aria-label="搜索聊天标题"]')`,
        ),
      '回车从本机打开远程搜索结果',
    )
    const remoteAfterSearch = await evaluate('window.multiServiceTest.remote.status()')
    assert.deepEqual(remoteAfterSearch.switchedPaths, [...remoteBeforeSearch.switchedPaths, 'same-path'])
    assert.equal(remoteAfterSearch.connection.sessionFile, 'same-path')
    assert.deepEqual(await evaluate('window.multiServiceTest.local.status()'), localBeforeSearch)
    await assertHiddenSearchInactive()
    await openSearch('control')
    assert.equal(await evaluate(`document.querySelector('[aria-label="搜索聊天标题"]').value`), '')
    await window.webContents.insertText('local旧对话')
    await waitFor(
      () => evaluate(`document.querySelectorAll('[aria-label="聊天搜索结果"] [role="option"]').length === 1`),
      '远程页面按标题筛选本机聊天',
    )
    assert.equal(await selectedSearchTitle(), 'local旧对话')
    pressKey('Enter')
    await waitFor(
      () =>
        evaluate(
          `document.querySelector('main').dataset.activeService === 'local' && !document.querySelector('[aria-label="搜索聊天标题"]')`,
        ),
      '回车从远程返回本机搜索结果',
    )
    const localAfterSearch = await evaluate('window.multiServiceTest.local.status()')
    assert.deepEqual(localAfterSearch.switchedPaths, [...localBeforeSearch.switchedPaths, 'same-path'])
    assert.equal(localAfterSearch.connection.sessionFile, 'same-path')
    assert.deepEqual(await evaluate('window.multiServiceTest.remote.status()'), remoteAfterSearch)
    await assertHiddenSearchInactive()
    console.log(
      '多服务界面验收通过：同名同路径隔离、取消保留、文字图片计划模式迁移、旧对话草稿与后台事件隔离、跨服务键盘搜索与隐藏 App 快捷键隔离',
    )
  } finally {
    window.destroy()
  }
}
