const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')

module.exports = async (window, waitFor, directory, outputDirectory) => {
  const evaluate = (code) => window.webContents.executeJavaScript(code)
  const pluginId = '@pi-meme-fixtures/desktop-smoke'
  const clickText = (text) =>
    evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find(node => node.checkVisibility() && node.textContent.trim() === ${JSON.stringify(text)});
    if (!button) throw new Error('找不到按钮：' + ${JSON.stringify(text)}); button.click();
  })()`)
  assert.equal(await fs.stat(path.join(directory, 'smoke-app', 'dist', 'agent.js')).then((file) => file.isFile()), true)
  const descriptors = await evaluate('window.smokeRpc("plugins:list")')
  assert.ok(descriptors.some((plugin) => plugin.id === pluginId && plugin.capabilities.agent && plugin.enabled))
  const key = await evaluate('window.piMemeClient.getConnection().then(value => value.sessionKey)')
  await evaluate(`window.piMemeClient.setAccessMode(${JSON.stringify(key)},'full-access')`)
  try {
    await evaluate(`(async () => {
    const session = await window.piMemeClient.resolveAppSession(${JSON.stringify(key)});
    await window.smokeControl('sessions.configure',[{hostId:session.hostId,sessionId:session.sessionId},{agentPlugins:[${JSON.stringify(pluginId)}]}],true);
  })()`)
    await evaluate('document.querySelector("button[aria-label=设置]").click()')
    await clickText('插件')
    await waitFor(
      () =>
        evaluate(
          `document.querySelector('section[aria-label="插件管理"]')?.textContent.includes(${JSON.stringify(pluginId)})`,
        ),
      'App 插件目录',
    )
    assert.equal(
      await evaluate(`document.querySelector('section[aria-label="插件管理"] [aria-label="资源类型"]') === null`),
      true,
    )
    assert.equal(
      await evaluate(`document.querySelector('section[aria-label="插件管理"]').textContent.includes("新建技能")`),
      false,
    )
    assert.equal(
      await evaluate(
        `[...document.querySelectorAll('nav[aria-label="设置分类"] button')].some(node => node.textContent.trim() === "资源")`,
      ),
      false,
    )
    assert.equal(
      await evaluate(`Boolean(document.querySelector('section[aria-label="插件管理"] [aria-label="添加插件"]'))`),
      true,
    )
    assert.equal(
      await evaluate(`Boolean(document.querySelector('section[aria-label="插件管理"] input[accept=".pim"]'))`),
      true,
    )
    assert.equal(await evaluate('document.body.innerText.includes("Pi 扩展")'), false)
    assert.equal(await evaluate('document.body.innerText.includes("上传文件")'), false)
    assert.equal(await evaluate('document.body.innerText.includes("加载 Host 目录")'), false)
    await fs.writeFile(
      path.join(outputDirectory, 'app-plugins-settings.png'),
      (await window.webContents.capturePage()).toPNG(),
    )
    await clickText('返回聊天')
    await evaluate(`window.piMemeClient.prompt(${JSON.stringify(key)},'插件命令验收前置会话')`)
    await waitFor(
      () =>
        evaluate(
          'window.piMemeClient.getSnapshot().then(value => value.connection.status === "ready" && !value.state.isStreaming)',
        ),
      '插件命令运行时就绪',
    )
    const commands = await evaluate('window.piMemeClient.getCommands()')
    const command = commands.find((value) => value.description === '触发插件异常')
    assert.ok(command, `App 插件异常命令已加载：${JSON.stringify(commands)}`)
    await evaluate(`window.piMemeClient.prompt(${JSON.stringify(key)},${JSON.stringify(`/${command.name}`)})`)
    await waitFor(() => evaluate('document.body.innerText.includes("Pi 扩展异常")'), 'App 插件命令异常摘要')
    await evaluate(
      `[...document.querySelectorAll('[data-error-line] summary')].find(node => node.textContent.includes('Pi 扩展异常')).click()`,
    )
    await waitFor(() => evaluate('document.body.innerText.includes("模拟插件异常")'), '展开 App 插件命令异常详情')
    assert.equal(await evaluate('window.piMemeClient.getConnection().then(value => value.status)'), 'ready')
    await fs.writeFile(
      path.join(outputDirectory, 'app-plugin-error.png'),
      (await window.webContents.capturePage()).toPNG(),
    )
  } finally {
    await evaluate(`window.piMemeClient.setAccessMode(${JSON.stringify(key)},'workspace-write')`)
  }
}
