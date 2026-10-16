const assert = require('node:assert/strict')

module.exports = async function fileCompletionSmoke(window, waitFor, setDraft, capture) {
  const evaluate = (code) => window.webContents.executeJavaScript(code)
  const key = async (value) => {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: value })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: value })
  }
  const options = '[role="listbox"][aria-label="项目文件选择"]'
  await setDraft('@')
  await waitFor(
    () => evaluate(`document.querySelector(${JSON.stringify(options)})?.textContent.includes('reference-fixture/')`),
    '项目根目录文件补全',
  )
  await capture('file-completion-root')
  await key('Tab')
  await waitFor(
    () => evaluate(`document.querySelector(${JSON.stringify(options)})?.textContent.includes('中文 文件.ts')`),
    'Tab 进入目录',
  )
  assert.equal(await evaluate('document.querySelector("[aria-label=消息]").textContent'), '@reference-fixture/')
  await capture('file-completion-directory')
  await evaluate('document.querySelector("nav[aria-label=文件目录] button").click()')
  await waitFor(
    () => evaluate(`document.querySelector(${JSON.stringify(options)})?.textContent.includes('reference-fixture/')`),
    '返回项目目录',
  )
  await setDraft('请看 @中文')
  await waitFor(
    () => evaluate(`document.querySelector(${JSON.stringify(options)})?.textContent.includes('中文 文件.ts')`),
    '搜索嵌套中文文件',
  )
  await key('Enter')
  await waitFor(
    () =>
      evaluate(
        'document.querySelector("[aria-label=消息]").textContent === \'请看 @"reference-fixture/中文 文件.ts" \'',
      ),
    '插入含空格的文件引用',
  )
  assert.equal(await evaluate(`Boolean(document.querySelector(${JSON.stringify(options)}))`), false)
  assert.equal(await evaluate('window.piMemeClient.getConnection().then(connection => connection.status)'), 'idle')
  await setDraft('@reference-fixture/')
  await waitFor(
    () => evaluate(`document.querySelector(${JSON.stringify(options)})?.textContent.includes('nested-file.ts')`),
    '直接输入目录路径',
  )
  await key('Escape')
  await waitFor(() => evaluate(`!document.querySelector(${JSON.stringify(options)})`), 'Esc 关闭文件补全')
  await setDraft('@no-matching-file-12345')
  await waitFor(
    () => evaluate(`document.querySelector(${JSON.stringify(options)})?.textContent.includes('没有匹配的文件')`),
    '文件搜索无结果',
  )
  await key('Enter')
  assert.equal(await evaluate('window.piMemeClient.getConnection().then(connection => connection.status)'), 'idle')
  await setDraft('')
}
