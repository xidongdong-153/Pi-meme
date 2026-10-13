const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')

module.exports = async function agentAccessSmoke(window, waitFor, directory) {
  const evaluate = (code) =>
    window.webContents.executeJavaScript(code).catch((cause) => {
      console.error('权限验收脚本失败：', code)
      throw cause
    })
  const selector = '[aria-label="Agent 访问权限"]'
  const snapshot = await evaluate('window.piMemeClient.getSnapshot()')
  const key = snapshot.connection.sessionKey
  const sessionFile = snapshot.connection.sessionFile
  assert.equal(snapshot.connection.accessMode, 'workspace-write')
  const open = () =>
    evaluate(
      `document.querySelector('${selector}').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`,
    )
  const choose = async (label, mode) => {
    await open()
    try {
      await waitFor(() => evaluate(`document.querySelectorAll('[role="option"]').length === 3`), '权限菜单展开')
    } catch (cause) {
      console.error('权限菜单诊断', {
        nativeFocus: window.isFocused(),
        renderer: await evaluate(`(() => {
          const trigger = document.querySelector('${selector}');
          return {focused:document.hasFocus(),active:document.activeElement?.outerHTML,trigger:trigger?.outerHTML,
            options:[...document.querySelectorAll('[role="option"]')].map(node=>({state:node.dataset.state,text:node.textContent}))};
        })()`),
      })
      throw cause
    }
    await evaluate(
      `([...document.querySelectorAll('[role="option"]')].find(node => node.textContent.includes(${JSON.stringify(label)}))).click()`,
    )
    await waitFor(
      () =>
        evaluate(
          `window.piMemeClient.getSnapshot().then(value => value.connection.accessMode === ${JSON.stringify(mode)} && !value.connection.accessChanging)`,
        ),
      '权限切换完成',
    )
    await waitFor(
      () => evaluate(`document.querySelector('${selector}').getAttribute('aria-expanded') === 'false'`),
      '权限菜单关闭',
    )
    await waitFor(
      () =>
        evaluate(
          `document.querySelector('[role=combobox][aria-label=消息]')?.isContentEditable && !document.querySelector('${selector}').disabled`,
        ),
      '权限切换后控件与输入器恢复可操作',
    )
  }
  await evaluate(
    `(() => { const editor = document.querySelector('[contenteditable=true][aria-label="消息"]'); editor.textContent = '权限切换保留的草稿'; editor.dispatchEvent(new Event('input', { bubbles: true })); })()`,
  )
  await open()
  await waitFor(() => evaluate(`document.querySelectorAll('[role="option"]').length === 3`), '权限菜单键盘展开')
  assert.equal(await evaluate(`document.body.textContent.includes('受限模式不加载外部 Agent 插件')`), true)
  await fs.writeFile(
    path.join(__dirname, '..', 'out', 'desktop-smoke', 'agent-access-menu.png'),
    (await window.webContents.capturePage()).toPNG(),
  )
  await evaluate(
    `document.querySelector('[role="option"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
  )
  await waitFor(
    () => evaluate(`document.querySelector('${selector}').getAttribute('aria-expanded') === 'false'`),
    'Escape 关闭菜单',
  )
  assert.equal(await evaluate(`document.activeElement === document.querySelector('${selector}')`), true)
  await choose('仅可查看', 'read-only')
  assert.equal(
    await evaluate(`document.querySelector('[contenteditable=true][aria-label="消息"]').textContent`),
    '权限切换保留的草稿',
  )
  assert.equal(await evaluate('window.piMemeClient.getConnection().then(value => value.status)'), 'idle')
  const records = JSON.parse(await fs.readFile(path.join(directory, 'agent-permissions.json'), 'utf8'))
  assert.equal(records[await fs.realpath(sessionFile)], 'read-only')
  await evaluate(`window.piMemeClient.prompt(${JSON.stringify(key)}, 'background-stream')`)
  await waitFor(() => evaluate(`document.querySelector('${selector}').disabled === true`), '运行时禁用权限切换')
  assert.equal(
    await evaluate(
      `window.piMemeClient.setAccessMode(${JSON.stringify(key)}, 'full-access').then(() => false, error => error.message.includes('任务结束后'))`,
    ),
    true,
  )
  await evaluate('window.piMemeClient.newSession()')
  await waitFor(
    () =>
      evaluate(
        `window.piMemeClient.getConnection().then(value => value.sessionKey !== ${JSON.stringify(key)} && value.accessMode === 'workspace-write')`,
      ),
    '新会话默认权限',
  )
  await evaluate(`window.piMemeClient.abort(${JSON.stringify(key)})`)
  await evaluate(`window.piMemeClient.switchSession(${JSON.stringify(sessionFile)})`)
  await waitFor(
    () =>
      evaluate(
        `document.querySelector('${selector}').textContent.includes('仅可查看') && !document.querySelector('${selector}').disabled`,
      ),
    '返回后台会话恢复权限',
  )
  await choose('完全权限', 'full-access')
  assert.equal(await evaluate(`window.piMemeClient.getConnection().then(value => value.accessMode)`), 'full-access')
  await choose('工作区内修改', 'workspace-write')
  await evaluate(
    `(() => { const editor = document.querySelector('[contenteditable=true][aria-label="消息"]'); editor.textContent = ''; editor.dispatchEvent(new Event('input', { bubbles: true })); })()`,
  )
}
