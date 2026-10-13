const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')

module.exports = async function lazySessionsSmoke(window, waitFor, directory, projectDirectory) {
  const evaluate = (code) => window.webContents.executeJavaScript(code)
  const idle = () => evaluate('window.piMemeClient.getConnection().then((value) => value.status === "idle")')
  const fixtures = path.resolve(__dirname, '../../../tests/fixtures')
  const { assistantMessage, userMessage } = await import(path.join(fixtures, 'messages.mjs'))
  const sessionsDirectory = require('./runtime-paths.cjs').sessionDirectory(directory, projectDirectory)
  await fs.mkdir(sessionsDirectory, { recursive: true })
  const file = path.join(sessionsDirectory, 'saved.jsonl')
  const timestamp = '2026-09-29T00:00:00Z'
  const content = [
    { type: 'session', id: 'lazy', version: 3, cwd: projectDirectory, timestamp },
    { type: 'model_change', id: 'model', parentId: null, timestamp, provider: 'fake', modelId: 'first' },
    { type: 'message', id: 'user', parentId: 'model', timestamp, message: userMessage('按需加载的历史问题', 1) },
    {
      type: 'message',
      id: 'answer',
      parentId: 'user',
      timestamp,
      message: assistantMessage('无需启动 Pi 的历史正文', 2),
    },
    { type: 'session_info', id: 'name', parentId: 'answer', timestamp, name: '按需历史' },
  ]
    .map((entry) => JSON.stringify(entry))
    .join('\n')
  await fs.writeFile(file, content)
  await evaluate(`window.piMemeClient.chooseDirectory(${JSON.stringify(projectDirectory)})`)
  for (let count = 0; count < 3; count++) await evaluate('window.piMemeClient.newSession()')
  assert.equal(await idle(), true, '新建会话不启动运行时')
  const selector = `aside [data-session-path=${JSON.stringify(file)}] > button:first-child`
  await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), '发现冷会话')
  await evaluate(`(() => {
    const button = [...document.querySelectorAll(${JSON.stringify(selector)})].find(node => !node.closest('[inert]') && node.getClientRects().length)
    button.focus()
  })()`)
  await waitFor(
    () => evaluate(`document.activeElement?.parentElement.dataset.sessionPath === ${JSON.stringify(file)}`),
    '历史会话按钮获得焦点',
  )
  assert.equal(await evaluate('document.activeElement.tagName'), 'BUTTON')
  await evaluate('document.activeElement.click()')
  await waitFor(
    () =>
      evaluate(`document.querySelector('[aria-label="对话消息流"]')?.textContent.includes('无需启动 Pi 的历史正文')`),
    '冷会话直接渲染历史',
  )
  assert.equal(
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-current')`),
    'true',
  )
  await waitFor(
    () =>
      evaluate(`window.piMemeClient.getConnection().then(connection =>
        connection.sessionFile === ${JSON.stringify(file)} &&
        document.querySelector('[aria-label="在顶栏选择项目"]')?.disabled === false &&
        document.querySelector('[aria-label="选择模型与思考强度"]')?.disabled === false)`),
    '冷会话选择完成后恢复输入与项目操作',
  )
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  await evaluate(`(() => {
    const button = [...document.querySelectorAll(${JSON.stringify(selector)})].find(node => !node.closest('[inert]') && node.getClientRects().length)
    button.focus()
  })()`)
  await waitFor(
    () => evaluate(`document.activeElement?.parentElement.dataset.sessionPath === ${JSON.stringify(file)}`),
    '历史会话按钮获得焦点',
  )
  await waitFor(
    () =>
      evaluate(
        `getComputedStyle(document.activeElement.parentElement.querySelector('button[aria-label]')).opacity === '1'`,
      ),
    '键盘聚焦时置顶操作显示',
  )
  assert.equal(
    await evaluate(
      `getComputedStyle(document.activeElement.parentElement.querySelector('button[aria-label]')).opacity`,
    ),
    '1',
    '会话行获得键盘焦点时置顶操作可见',
  )
  assert.equal(await idle(), true, '阅读历史不启动运行时')
  assert.equal(await fs.readFile(file, 'utf8'), content)
  assert.equal(await evaluate('document.querySelector("header").textContent.includes("连接中")'), false)
  assert.equal(await evaluate(`document.querySelector('[aria-label="消息"]')?.isContentEditable`), true)
  await evaluate(`(() => {
      const editor = document.querySelector('[aria-label="消息"]');
      editor.textContent = 'background-stream';
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
  await waitFor(() => evaluate(`document.querySelector('[aria-label="发送消息"]')?.disabled === false`), '准备首次发送')
  await evaluate(`document.querySelector('[aria-label="发送消息"]').click()`)
  await waitFor(
    () => evaluate('window.piMemeClient.getConnection().then((value) => value.status !== "idle")'),
    '首次发送才启动运行时',
  )
  await evaluate('window.piMemeClient.newSession()')
  await waitFor(() => evaluate('document.querySelector("h1")?.textContent === "开始一个新任务"'), '运行期间可以切换')
  await waitFor(
    () =>
      evaluate(
        `window.piMemeClient.getSessions().then((value) => value.recents.some((session) => session.path === ${JSON.stringify(file)} && session.running))`,
      ),
    '发送任务保留在原会话',
  )
  await evaluate(`(() => {
    const button = [...document.querySelectorAll(${JSON.stringify(selector)})].find(node => !node.closest('[inert]') && node.getClientRects().length)
    if (!button) throw new Error('未找到可见的历史会话入口')
    button.click()
  })()`)
  await waitFor(
    () => evaluate(`document.querySelector('[aria-label="对话消息流"]')?.textContent.includes('后台流式正文')`),
    '切回恢复首次发送的正文',
  )
  assert.equal(
    await evaluate('window.piMemeClient.getSnapshot().then((value) => value.connection.sessionFile)'),
    file,
    '运行时打开的是选中的历史会话文件',
  )
  await fs.writeFile(
    path.join(__dirname, '../out/desktop-smoke/lazy-sessions.png'),
    (await window.webContents.capturePage()).toPNG(),
  )
  await evaluate(
    'window.piMemeClient.getConnection().then(connection => window.piMemeClient.abort(connection.sessionKey))',
  )
  await waitFor(
    () =>
      evaluate('window.piMemeClient.getSessions().then((value) => value.recents.every((session) => !session.running))'),
    '结束按需任务',
  )
  console.log('按需会话验收通过：启动页与冷会话不启动运行时、历史只读、首次发送启动、运行期间可切换、消息路由保持正确')
}
