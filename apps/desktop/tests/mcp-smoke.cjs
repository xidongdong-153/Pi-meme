const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')

module.exports = async (window, waitFor, output) => {
  const evaluate = (code) =>
    window.webContents.executeJavaScript(code).catch((cause) => {
      console.error(code)
      throw cause
    })
  const click = async (text) => {
    await waitFor(
      () =>
        evaluate(
          `[...document.querySelectorAll('button')].some(node => node.textContent.trim() === ${JSON.stringify(text)} && !node.disabled)`,
        ),
      `按钮可用：${text}`,
    )
    await evaluate(
      `(() => { const node = [...document.querySelectorAll('button')].find(node => node.textContent.trim() === ${JSON.stringify(text)}); node.click() })()`,
    )
  }
  const input = (label, value) =>
    evaluate(
      `(() => { const node = document.querySelector('[aria-label=${JSON.stringify(label)}]'); const prototype = node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, ${JSON.stringify(value)}); node.dispatchEvent(new Event('input', { bubbles: true })) })()`,
    )
  const ready = () =>
    waitFor(
      () => evaluate('window.piMemeClient.getConnection().then(value => value.status === "ready")'),
      '配置重连完成',
    )
  const toggle = async (label) => {
    const selector = `[aria-label=${JSON.stringify(label)}]`
    await waitFor(
      () => evaluate(`document.querySelector(${JSON.stringify(selector)}).disabled === false`),
      `开关可用：${label}`,
    )
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  }
  const saved = (predicate) =>
    waitFor(() => evaluate(`window.piMemeClient.getMcpConfig().then(value => ${predicate})`), 'MCP 配置保存')
  const capture = async (name) => {
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    await fs.writeFile(path.join(output, `${name}.png`), (await window.webContents.capturePage()).toPNG())
  }
  await evaluate('document.querySelector("button[aria-label=设置]").click()')
  await click('MCP')
  await waitFor(() => evaluate('document.body.textContent.includes("尚未配置 Desktop 全局 MCP 服务")'), '空配置')
  assert.equal(await evaluate('document.querySelector("input[aria-label=\\"在 Desktop 中启用 MCP\\"]").checked'), false)
  assert.equal(
    await evaluate(
      '[...document.querySelectorAll("button")].find(node => node.textContent === "检查全部全局服务").disabled',
    ),
    true,
  )
  await click('新增 MCP 服务')
  await input('MCP 服务名称', 'demo')
  await input('MCP URL', 'http://127.0.0.1:45678/mcp')
  await click('编辑高级 JSON')
  const config = {
    url: 'http://127.0.0.1:45678/mcp',
    exposure: 'codemode',
    timeout: 1000,
    oauth: {},
    customField: { keep: true },
  }
  await input('MCP 高级 JSON', JSON.stringify(config, null, 2))
  await click('切换到表单')
  await input('服务说明', '桌面验收模拟服务')
  await click('保存服务')
  await saved('value.servers.some(entry => entry.name === "demo")')
  await ready()
  assert.equal(
    await evaluate('window.piMemeClient.getMcpConfig().then(value => value.servers[0].config.customField.keep)'),
    true,
  )
  await click('新增 MCP 服务')
  await input('MCP 服务名称', 'local')
  await evaluate(
    `(() => { const node = document.querySelector('[aria-label="MCP 连接类型"]'); node.value = 'stdio'; node.dispatchEvent(new Event('change', { bubbles: true })) })()`,
  )
  await input('可执行命令', 'node')
  await input('MCP 参数', '["server.mjs"]')
  await input('MCP 环境变量', '{"FIXTURE":"true"}')
  await input('工作目录', path.dirname((await evaluate('window.piMemeClient.getMcpConfig()')).path))
  await click('保存服务')
  await saved(
    'value.servers.some(entry => entry.name === "local" && entry.config.args[0] === "server.mjs" && entry.config.env.FIXTURE === "true")',
  )
  await ready()
  await click('删除 local')
  await click('确认删除 local')
  await saved('value.servers.length === 1')
  await ready()
  await click('禁用 demo')
  await saved('value.servers[0].config.enabled === false')
  await ready()
  await click('启用 demo')
  await saved('value.servers[0].config.enabled === true')
  await ready()
  await toggle('在 Desktop 中启用 MCP')
  await waitFor(
    () =>
      evaluate(
        'window.piMemeClient.getSettings().then(value => value.settings.mcpEnabled && value.settings.codemodeEnabled)',
      ),
    '能力开关联动',
  )
  await ready()
  await capture('mcp-settings')
  await click('工具执行')
  await toggle('启用 codemode')
  assert.equal(await evaluate('document.body.textContent.includes("保存后将同时关闭 Desktop MCP")'), true)
  await capture('codemode-settings')
  await click('保存工具执行设置')
  await waitFor(
    () =>
      evaluate(
        'window.piMemeClient.getSettings().then(value => !value.settings.mcpEnabled && !value.settings.codemodeEnabled)',
      ),
    '关闭联动',
  )
  await ready()
  await click('MCP')
  await click('编辑 demo')
  await input('服务说明', '不应覆盖外部配置')
  const snapshot = await evaluate('window.piMemeClient.getMcpConfig()')
  const external = { mcpServers: { demo: { ...config, description: '外部修改' } }, rootField: true }
  await fs.writeFile(snapshot.path, JSON.stringify(external))
  await click('保存服务')
  await waitFor(() => evaluate('document.body.textContent.includes("其他程序修改")'), '外部修改冲突')
  assert.deepEqual(JSON.parse(await fs.readFile(snapshot.path, 'utf8')), external)
  await click('重新加载配置')
  await waitFor(() => evaluate('!document.querySelector("form[aria-label=\\"MCP 服务编辑\\"]")'), '重新加载关闭编辑')
  await click('编辑 demo')
  await input('MCP 服务名称', 'renamed')
  await click('保存服务')
  await saved('value.servers[0].name === "renamed"')
  await ready()
  await click('删除 renamed')
  await click('确认删除 renamed')
  await saved('value.servers.length === 0')
  await ready()
  const clean = await fs.readFile(snapshot.path, 'utf8')
  await fs.writeFile(snapshot.path, '{损坏文件')
  await click('重新加载配置')
  await waitFor(
    () =>
      evaluate(
        'document.body.textContent.includes("损坏") && [...document.querySelectorAll("button")].find(node => node.textContent === "新增 MCP 服务").disabled',
      ),
    '损坏配置不允许覆盖',
  )
  assert.equal(await fs.readFile(snapshot.path, 'utf8'), '{损坏文件')
  await fs.writeFile(snapshot.path, clean)
  await click('重新加载配置')
  await click('返回聊天')
  const connection = await evaluate('window.piMemeClient.getConnection()')
  await evaluate(`window.piMemeClient.setAccessMode(${JSON.stringify(connection.sessionKey)}, 'full-access')`)
  await evaluate('document.querySelector("button[aria-label=设置]").click()')
  await click('MCP')
  await waitFor(
    () =>
      evaluate(
        '[...document.querySelectorAll("button")].find(node => node.textContent === "检查全部全局服务")?.disabled === false',
      ),
    '完全权限可诊断',
  )
  const nodeBinary = require('node:child_process')
    .execFileSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' })
    .trim()
  const mcpFixture = path.join(__dirname, '..', '..', '..', 'tests', 'fixtures', 'mcp-server.mjs')
  await fs.writeFile(
    snapshot.path,
    JSON.stringify({ mcpServers: { check: { command: nodeBinary, args: [mcpFixture, '--stdio'] } } }),
  )
  await click('重新加载配置')
  await click('检查全部全局服务')
  await waitFor(
    () => evaluate('document.querySelector("section[aria-label=\\"MCP 诊断结果\\"]")?.textContent.includes("已连接")'),
    '诊断展示',
  )
  assert.equal(await evaluate('document.body.textContent.includes("不代表当前聊天的实时连接状态")'), true)
  const size = window.getSize()
  window.setSize(720, 650)
  await capture('mcp-settings-narrow')
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true)
  window.setSize(...size)
  await click('工具执行')
  await toggle('启用 codemode')
  await click('保存工具执行设置')
  await waitFor(
    () => evaluate('window.piMemeClient.getSettings().then(value => value.settings.codemodeEnabled)'),
    '重新开启 codemode',
  )
  await click('返回聊天')
  await evaluate(`window.piMemeClient.setAccessMode(${JSON.stringify(connection.sessionKey)}, 'workspace-write')`)
  await evaluate(
    `(() => { const node = document.querySelector('[contenteditable=true][aria-label="消息"]'); node.textContent = 'codemode-smoke'; node.dispatchEvent(new Event('input', { bubbles: true })) })()`,
  )
  await evaluate('document.querySelector("button[aria-label=发送消息]").click()')
  await waitFor(
    () =>
      evaluate(
        'window.piMemeClient.getConnection().then(value => !value.running) && document.body.textContent.includes("嵌套调用验收完成")',
      ),
    '嵌套工具消息',
  )
  await evaluate('document.querySelector("[role=button][aria-label=工作过程]").click()')
  await waitFor(
    () => evaluate('Boolean(document.querySelector("[aria-label=\\"工具详情：codemode\\"]"))'),
    'codemode 活动',
  )
  await evaluate('document.querySelector("[aria-label=\\"工具详情：codemode\\"]").click()')
  await waitFor(
    () =>
      evaluate('Boolean(document.querySelector("[data-parent-tool=code-smoke] [aria-label=\\"工具详情：read\\"]"))'),
    '嵌套内部调用',
  )
  assert.equal(await evaluate('document.querySelectorAll("[aria-label=\\"工具详情：read\\"]").length'), 1)
  assert.equal(
    await evaluate(
      'document.querySelector("pre[aria-label=\\"codemode 执行脚本\\"]").textContent.includes("tools.read")',
    ),
    true,
  )
  await capture('codemode-nested-tools')
}
