const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')

module.exports = async function backgroundSessionsSmoke(window, waitFor, secondDirectory, screenshots) {
  const evaluate = (code) => window.webContents.executeJavaScript(code)
  const sidebarOrder = () =>
    evaluate(`({
    recents: [...document.querySelectorAll('aside [data-sidebar-section="recents"] [data-session-path]')].map(node => node.dataset.sessionPath),
    projects: [...document.querySelectorAll('aside [data-sidebar-section="projects"] [data-project-cwd]')].map(node => node.dataset.projectCwd),
  })`)
  const clickNew = () =>
    evaluate(
      `Array.from(document.querySelectorAll('aside button')).find((button) => button.textContent.trim() === '新聊天').click()`,
    )
  const draft = (text) =>
    evaluate(`(() => {
    const editor = document.querySelector('[aria-label="消息"][contenteditable=true]');
    editor.textContent = ${JSON.stringify(text)};
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  const start = async () => {
    await waitFor(
      () => evaluate(`document.querySelector('h1')?.textContent === '开始一个新任务'`),
      '新建聊天立即显示输入区',
    )
    await draft('background-stream')
    await waitFor(
      () => evaluate(`document.querySelector('[aria-label="发送消息"]')?.disabled === false`),
      '目标运行时准备完成',
    )
    await evaluate(`document.querySelector('[aria-label="发送消息"]').click()`)
    await waitFor(
      () => evaluate(`document.querySelector('[aria-label="对话消息流"]')?.textContent.includes('后台流式正文')`),
      '后台流式正文',
    )
    return evaluate('window.piMemeClient.getSessions().then((sessions) => sessions.activeSessionPath)')
  }
  const select = async (sessionPath) => {
    const selector = `aside [data-session-path=${JSON.stringify(sessionPath)}] > button:first-child`
    await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), '侧栏实时显示新会话')
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
    await waitFor(
      () =>
        evaluate(
          `window.piMemeClient.getSessions().then((sessions) => sessions.activeSessionPath === ${JSON.stringify(sessionPath)})`,
        ),
      '切换当前查看会话',
    )
    await waitFor(
      () => evaluate('window.piMemeClient.getSnapshot().then(snapshot => snapshot.state.isStreaming)'),
      '恢复后台运行状态',
    )
  }
  const originalCwd = await evaluate('window.piMemeClient.getConnection().then((connection) => connection.cwd)')
  await clickNew()
  const emptyPath = await evaluate('window.piMemeClient.getSessions().then((sessions) => sessions.activeSessionPath)')
  assert.equal(
    await evaluate(
      `window.piMemeClient.getSessions().then((sessions) => sessions.recents.some((session) => session.path === ${JSON.stringify(emptyPath)}))`,
    ),
    false,
  )
  await evaluate(`window.piMemeClient.chooseDirectory(${JSON.stringify(secondDirectory)})`)
  const otherEmptyPath = await evaluate(
    'window.piMemeClient.getSessions().then((sessions) => sessions.activeSessionPath)',
  )
  await evaluate(`window.piMemeClient.chooseDirectory(${JSON.stringify(originalCwd)})`)
  assert.equal(
    await evaluate(
      `window.piMemeClient.getSessions().then((sessions) => sessions.recents.some((session) => [${JSON.stringify(emptyPath)}, ${JSON.stringify(otherEmptyPath)}].includes(session.path)))`,
    ),
    false,
  )
  const firstPath = await start()
  const beforeAppearance = await evaluate(
    'window.piMemeClient.getSnapshot().then(snapshot => ({ key: snapshot.connection.sessionKey, sequence: snapshot.eventSequence }))',
  )
  await evaluate(`document.querySelector('button[aria-label="设置"]').click()`)
  await waitFor(() => evaluate(`Boolean(document.querySelector('nav[aria-label="设置分类"]'))`), '运行中打开设置')
  await evaluate(
    `Array.from(document.querySelectorAll('nav button')).find(node => node.textContent.trim() === '外观').click()`,
  )
  await waitFor(() => evaluate('Boolean(document.querySelector(\'[aria-label="深色模式"]\'))'), '外观页面加载')
  await evaluate(`document.querySelector('[aria-label="深色模式"]').click()`)
  await waitFor(
    () => evaluate(`window.piMemeClient.getSettings().then(snapshot => snapshot.settings.appearance.mode === 'dark')`),
    '运行中保存外观',
  )
  const afterAppearance = await evaluate(
    'window.piMemeClient.getSnapshot().then(snapshot => ({ key: snapshot.connection.sessionKey, sequence: snapshot.eventSequence }))',
  )
  assert.equal(afterAppearance.key, beforeAppearance.key)
  assert.ok(afterAppearance.sequence >= beforeAppearance.sequence)
  await evaluate(
    `Array.from(document.querySelectorAll('button')).find(node => node.textContent.trim() === '返回聊天').click()`,
  )
  await waitFor(
    () => evaluate(`Boolean(document.querySelector('[aria-label="暂停当前任务"]'))`),
    '外观修改保留运行任务',
  )
  await evaluate(`window.piMemeClient.chooseDirectory(${JSON.stringify(secondDirectory)})`)
  const secondPath = await start()
  assert.notEqual(firstPath, secondPath)
  await waitFor(
    () =>
      evaluate(
        'window.piMemeClient.getSessions().then((sessions) => sessions.recents.filter((session) => session.running).length === 2)',
      ),
    '两个项目的任务同时运行',
  )
  await waitFor(
    () => evaluate(`document.querySelectorAll('aside [aria-label="会话运行中"]').length >= 2`),
    '侧栏显示两个运行图标',
  )
  await draft('第二个会话的待发草稿')
  await waitFor(async () => (await sidebarOrder()).recents.length === 2, '侧栏两个会话完成渲染')
  const order = await sidebarOrder()
  await select(firstPath)
  assert.deepEqual(await sidebarOrder(), order, '聚焦运行中的会话不改变可见侧栏顺序')
  assert.ok(await evaluate(`document.querySelector('[aria-label="对话消息流"]').textContent.includes('后台流式正文')`))
  assert.equal(await evaluate(`document.body.textContent.includes('正在加载会话，可以先编写消息')`), false)
  await evaluate(
    'window.piMemeClient.getConnection().then(connection => window.piMemeClient.abort(connection.sessionKey))',
  )
  await waitFor(
    () =>
      evaluate(
        `window.piMemeClient.getSessions().then((sessions) => !sessions.recents.find((session) => session.path === ${JSON.stringify(firstPath)})?.running && sessions.recents.find((session) => session.path === ${JSON.stringify(secondPath)})?.running)`,
      ),
    '停止当前任务不影响另一会话',
  )
  await fs.writeFile(
    path.join(screenshots, 'background-sessions.png'),
    (await window.webContents.capturePage()).toPNG(),
  )
  await waitFor(async () => (await sidebarOrder()).recents[0] === firstPath, '已停止会话按完成时间排到侧栏首位')
  const completedOrder = await sidebarOrder()
  assert.equal(completedOrder.recents[0], firstPath)
  await select(secondPath)
  assert.deepEqual(await sidebarOrder(), completedOrder, '切换后台会话保留侧栏的完成顺序')
  await waitFor(
    () => evaluate(`document.querySelector('[aria-label="消息"]').textContent.includes('第二个会话的待发草稿')`),
    '切回后恢复独立草稿',
  )
  await evaluate(
    'window.piMemeClient.getConnection().then(connection => window.piMemeClient.abort(connection.sessionKey))',
  )
  await waitFor(
    () =>
      evaluate(
        'window.piMemeClient.getSessions().then((sessions) => sessions.recents.every((session) => !session.running))',
      ),
    '后台任务全部停止',
  )
  assert.equal(
    await evaluate('window.piMemeClient.getSessions().then((sessions) => sessions.recents[0].path)'),
    secondPath,
  )
  assert.equal(
    await evaluate('window.piMemeClient.getSessions().then((sessions) => sessions.projects[0].cwd)'),
    secondDirectory,
  )
  const beforeRestore = await evaluate('window.piMemeClient.getSnapshot()')
  const beforeKeys = await evaluate(
    'window.piMemeClient.getSessions().then((sessions) => sessions.projects.flatMap((project) => project.sessions.map((session) => session.id)).sort())',
  )
  await evaluate(
    'window.piMemeClient.getSettings().then((snapshot) => window.piMemeClient.saveSettings(snapshot.settings))',
  )
  const afterRestore = await evaluate('window.piMemeClient.getSnapshot()')
  assert.equal(afterRestore.connection.sessionKey, beforeRestore.connection.sessionKey)
  assert.deepEqual(afterRestore.messages, beforeRestore.messages)
  assert.deepEqual(
    await evaluate(
      'window.piMemeClient.getSessions().then((sessions) => sessions.projects.flatMap((project) => project.sessions.map((session) => session.id)).sort())',
    ),
    beforeKeys,
  )
  await waitFor(
    () => evaluate(`document.querySelector('[aria-label="消息"]').textContent.includes('第二个会话的待发草稿')`),
    '配置重连保留当前草稿',
  )
  console.log(
    '多会话桌面验收通过：完成时间排序、聚焦不改变顺序、空会话不保存、跨项目并行运行、实时侧栏图标、自由切换、流式恢复、停止隔离和独立草稿',
  )
}
