const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')

module.exports = async (window, waitFor, directory, outputDirectory) => {
  const evaluate = (code) => window.webContents.executeJavaScript(code)
  const clickText = (text) =>
    evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find(node => node.checkVisibility() && node.textContent.trim() === ${JSON.stringify(text)});
    if (!button) throw new Error('找不到按钮：' + ${JSON.stringify(text)}); button.click();
  })()`)
  const extensionsDirectory = path.join(directory, 'pi', 'extensions')
  const extension = path.join(extensionsDirectory, 'smoke-extension.js')
  assert.equal(await fs.stat(extension).then((value) => value.isFile()), true)

  const key = await evaluate('window.piMemeClient.getConnection().then(value => value.sessionKey)')
  await evaluate(`window.piMemeClient.setAccessMode(${JSON.stringify(key)}, 'full-access')`)
  await evaluate('document.querySelector("button[aria-label=设置]").click()')
  await evaluate('document.querySelector("aside details").open = true')
  await clickText('开发者')
  await waitFor(() => evaluate('document.body.innerText.includes("Desktop 从应用数据目录加载扩展")'), '应用扩展设置')
  assert.equal(await evaluate('document.querySelector("#pi-user-extensions") === null'), true)
  assert.equal(
    await evaluate('window.piMemeClient.getSettings().then(value => value.extensionsDirectory)'),
    extensionsDirectory,
  )
  assert.equal(await evaluate('document.body.innerText.includes("打开扩展目录")'), true)
  await fs.writeFile(
    path.join(outputDirectory, 'extensions-settings.png'),
    (await window.webContents.capturePage()).toPNG(),
  )

  await clickText('返回聊天')
  await evaluate(`window.piMemeClient.prompt(${JSON.stringify(key)}, '/extension-error')`)
  await waitFor(() => evaluate('document.body.innerText.includes("模拟扩展异常")'), '应用扩展命令')
  assert.equal(await evaluate('window.piMemeClient.getConnection().then(value => value.status)'), 'ready')
  await fs.writeFile(
    path.join(outputDirectory, 'extension-error.png'),
    (await window.webContents.capturePage()).toPNG(),
  )
  await evaluate(`window.piMemeClient.setAccessMode(${JSON.stringify(key)}, 'workspace-write')`)
}
