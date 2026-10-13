const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')

module.exports = async function personalizationSmoke(window, waitFor, directory, screenshots) {
  const evaluate = (code) =>
    window.webContents.executeJavaScript(code).catch((error) => {
      console.error('偏好验收脚本执行失败：', code, error)
      throw error
    })
  const clickText = (text, scope = 'body') =>
    evaluate(
      `(() => { const root = document.querySelector(${JSON.stringify(scope)}); const button = [...root.querySelectorAll('button, [role=menuitem]')].find(node => node.textContent.trim() === ${JSON.stringify(text)}); if (!button) throw new Error('未找到操作：' + ${JSON.stringify(text)}); button.click() })()`,
    )
  const change = (label, value, tag = 'input') =>
    evaluate(
      `(() => { const input = document.querySelector('${tag}[aria-label="${label}"]'); Object.getOwnPropertyDescriptor(${tag === 'textarea' ? 'HTMLTextAreaElement' : 'HTMLInputElement'}.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })) })()`,
    )
  const capture = async (name) => {
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    await fs.writeFile(path.join(screenshots, `${name}.png`), (await window.webContents.capturePage()).toPNG())
  }
  const nav = 'nav[aria-label="设置分类"]'
  const select = async (name) => {
    if (['模型', '外观', '偏好', '插件', '技能', 'MCP'].includes(name)) {
      await clickText(name, nav)
    } else {
      await clickText(name)
    }
    await waitFor(
      () => evaluate(`document.querySelector('#settings-content h2')?.textContent === ${JSON.stringify(name)}`),
      `设置页面：${name}`,
    )
  }
  const originalSize = window.getSize()
  await select('偏好')
  await waitFor(
    () => evaluate('Boolean(document.querySelector("button[aria-label=\\"编辑指令：agents\\"]"))'),
    '偏好指令',
  )
  await capture('personalization-dark')
  assert.equal(await evaluate('Boolean(document.querySelector("[aria-label=新会话默认权限]"))'), true)
  await evaluate(
    'Array.from(document.querySelectorAll("#settings-content button")).find(button => button.textContent.includes("Pi 指令")).click()',
  )
  await waitFor(() => evaluate('Boolean(document.querySelector("textarea[aria-label=指令正文]"))'), '指令编辑器')
  assert.equal(
    await evaluate(
      'Array.from(document.querySelectorAll("#settings-content button")).find(button => button.textContent === "保存").disabled',
    ),
    true,
  )
  await change('指令正文', 'DESKTOP-HOST-INSTRUCTIONS', 'textarea')
  await clickText('插件', nav)
  await waitFor(() => evaluate('Boolean(document.querySelector("[role=dialog]"))'), '未保存草稿确认')
  await clickText('继续编辑', '[role=dialog]')
  assert.equal(
    await evaluate('document.querySelector("textarea[aria-label=指令正文]").value'),
    'DESKTOP-HOST-INSTRUCTIONS',
  )
  await clickText('保存', '#settings-content')
  await waitFor(
    async () =>
      (await fs.readFile(path.join(directory, 'pi', 'AGENTS.md'), 'utf8').catch(() => '')) ===
      'DESKTOP-HOST-INSTRUCTIONS',
    'Host 指令落盘',
  )
  await waitFor(
    () => evaluate('document.querySelector("#settings-content").textContent.includes("已保存并重新加载指令")'),
    '指令重载',
  )
  await capture('personalization-editor')
  await evaluate(`(() => {
    const original = window.piMemeClient.saveInstruction
    window.piMemeClient.saveInstruction = async (input) => {
      window.piMemeClient.saveInstruction = original
      return { ...await original(input), reloadError: '指令已保存，重载失败：验收错误。请点击重新加载。' }
    }
  })()`)
  await change('指令正文', 'DESKTOP-HOST-INSTRUCTIONS-RETRY', 'textarea')
  await clickText('保存', '#settings-content')
  await waitFor(
    () => evaluate('document.querySelector("#settings-content").textContent.includes("指令已保存，重载失败")'),
    '重载失败提示',
  )
  assert.equal(await fs.readFile(path.join(directory, 'pi', 'AGENTS.md'), 'utf8'), 'DESKTOP-HOST-INSTRUCTIONS-RETRY')
  await clickText('重新加载', '#settings-content')
  await waitFor(
    () => evaluate('document.querySelector("#settings-content").textContent.includes("已重新加载指令")'),
    '重载失败后重试',
  )
  await clickText('返回', '#settings-content')
  await select('远程')
  assert.equal(
    await evaluate('document.querySelector("#settings-content").textContent.includes("远程连接由此计算机管理")'),
    true,
  )
  assert.equal(
    await evaluate('document.querySelector("#settings-content").textContent.includes(window.location.origin)'),
    false,
    '远程设置不显示本机连接地址',
  )
  assert.equal(
    await evaluate(
      'window.piPlatform.getHostConnection().then(value => !value.hostId || !document.querySelector("#settings-content").textContent.includes(value.hostId))',
    ),
    true,
    '远程设置不显示本机服务身份',
  )
  assert.equal(await evaluate('Boolean(document.querySelector("#settings-content input[type=password]"))'), false)
  const pluginId = 'settings-smoke'
  const pluginDirectory = path.join(directory, 'settings-smoke-plugin')
  await fs.mkdir(path.join(pluginDirectory, 'dist', 'agent'), { recursive: true })
  await fs.writeFile(
    path.join(pluginDirectory, 'package.json'),
    JSON.stringify({ name: pluginId, version: '1.0.0', piMeme: { sdkVersion: 2, agent: 'dist/agent/entry.js' } }),
  )
  await fs.writeFile(path.join(pluginDirectory, 'dist', 'agent', 'entry.js'), 'export function activate() {}')
  await evaluate(`window.piMemePlugins.installDirectory(${JSON.stringify(pluginDirectory)})`)
  const expectedPluginCount = await evaluate('window.piMemePlugins.list().then(plugins => plugins.length)')
  await select('插件')
  await waitFor(
    () => evaluate(`document.querySelectorAll('ul[aria-label="App 插件列表"] li').length === ${expectedPluginCount}`),
    'App插件视图仅显示外部插件',
  )
  assert.equal(
    await evaluate(`document.querySelector('ul[aria-label="App 插件列表"]').textContent.includes('@pi-meme/')`),
    false,
  )
  assert.equal(await evaluate('document.querySelector("input[aria-label=搜索插件]").placeholder'), '搜索插件')
  await change('搜索插件', '不存在的插件')
  await waitFor(
    () => evaluate(`document.querySelectorAll('ul[aria-label="App 插件列表"] li').length === 0`),
    '插件搜索',
  )
  await change('搜索插件', '')
  await waitFor(
    () => evaluate(`document.querySelectorAll('ul[aria-label="App 插件列表"] li').length === ${expectedPluginCount}`),
    '恢复插件列表',
  )
  const assertResourceCopy = async () => {
    const { text, address, cwd } = await evaluate(`(async () => ({
      text: document.querySelector('#settings-content').innerText,
      address: window.location.origin,
      cwd: (await window.piMemeClient.getConnection()).cwd,
    }))()`)
    assert.equal(text.includes('Host'), false, 'App 插件列表页面使用设备名称')
    assert.equal(text.includes(address), false, 'App 插件列表页面不显示连接地址')
    assert.equal(text.includes(cwd), false, 'App 插件列表页面不直接显示项目路径')
  }
  await assertResourceCopy()
  await capture('plugins-dark')
  await evaluate(`document.querySelector('button[aria-label="查看插件：${pluginId}"]').click()`)
  await waitFor(
    () =>
      evaluate(
        `document.querySelector('section[aria-label="插件管理"] h3')?.textContent === ${JSON.stringify(pluginId)}`,
      ),
    '外部插件详情',
  )
  assert.equal(await evaluate('Boolean(document.querySelector("[role=dialog]"))'), false, '插件详情使用独立页面')
  await clickText('停用插件', 'section[aria-label="插件管理"]')
  await waitFor(
    () => evaluate('document.querySelector("section[aria-label=插件管理]").textContent.includes("已停用")'),
    '插件停用详情状态',
  )
  await clickText('返回插件', 'section[aria-label="插件管理"]')
  await waitFor(
    () =>
      evaluate(`document.querySelector('button[aria-label="查看插件：${pluginId}"]')?.textContent.includes('已停用')`),
    '插件停用列表状态',
  )
  await select('远程')
  assert.equal(await evaluate('document.querySelector("#settings-content").textContent.includes("配置远程服务")'), true)
  const origin = await evaluate('window.location.origin')
  await clickText('配置远程服务', '#settings-content')
  await waitFor(
    () => evaluate('document.querySelector("[role=dialog] h2")?.textContent === "配置远程服务"'),
    '远程配置弹窗',
  )
  assert.equal(await evaluate('document.querySelector("[aria-label=远程服务地址]").value'), '', '服务地址默认空')
  assert.equal(await evaluate('document.querySelector("[aria-label=远程访问令牌]").type'), 'password')
  assert.equal(await evaluate('document.querySelector("[aria-label=远程访问令牌]").value'), '', '令牌默认空')
  await evaluate('document.querySelector("[role=dialog] > button:last-child").click()')
  await waitFor(() => evaluate('!document.querySelector("[role=dialog]")'), '取消远程配置')
  assert.equal(await evaluate('window.location.origin'), origin, '取消远程配置保持本机页面')
  await evaluate(`window.piMemePlugins.enable(${JSON.stringify(pluginId)})`)
  await select('插件')
  await waitFor(
    () =>
      evaluate(`document.querySelector('button[aria-label="查看插件：${pluginId}"]')?.textContent.includes('已启用')`),
    '插件启用列表状态',
  )
  window.setSize(900, 720)
  await capture('plugins-narrow')
  assert.equal(
    await evaluate(
      'document.querySelector("#settings-content").scrollWidth <= document.querySelector("#settings-content").clientWidth',
    ),
    true,
  )
  await select('技能')
  await assertResourceCopy()
  assert.equal(
    await evaluate(
      'Boolean(document.querySelector("section[aria-label=技能管理]")) && document.querySelector("[aria-label=资源类型]") === null',
    ),
    true,
    '独立技能页面不显示类型切换',
  )
  await change('搜索技能', 'review-code')
  await waitFor(() => evaluate('document.querySelectorAll("ul[aria-label=技能列表] li").length === 1'), '技能搜索')
  const skillSource = path.join(directory, 'skills/review-code/SKILL.md')
  const originalSkill = await fs.readFile(skillSource, 'utf8')
  await evaluate(`document.querySelector('button[aria-label="查看技能：review-code"]').click()`)
  await waitFor(
    () => evaluate('document.querySelector("section[aria-label=技能管理] h3")?.textContent === "review-code"'),
    '技能资源详情',
  )
  assert.equal(
    await evaluate('document.querySelector("section[aria-label=技能管理]").textContent.includes("技能 · 此设备")'),
    true,
    '技能来源仍为当前设备',
  )
  await assertResourceCopy()
  await capture('skill-detail-dark')
  await evaluate(`(() => {
    const scope = document.querySelector('select[aria-label="技能策略范围"]')
    scope.value = 'project'
    scope.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  assert.equal(await evaluate('document.querySelector("select[aria-label=技能策略范围]").value'), 'project')
  await clickText('设为仅手动', 'section[aria-label="技能管理"]')
  await waitFor(
    () =>
      evaluate(
        '[...document.querySelectorAll("section[aria-label=技能管理] button")].some(button => button.textContent === "使用设备默认设置" && !button.disabled)',
      ),
    '技能项目覆盖策略',
  )
  assert.equal(await fs.readFile(skillSource, 'utf8'), originalSkill, '项目覆盖不修改Host技能源码')
  await clickText('使用设备默认设置', 'section[aria-label="技能管理"]')
  await waitFor(
    () =>
      evaluate(
        '[...document.querySelectorAll("section[aria-label=技能管理] button")].some(button => button.textContent === "设为仅手动" && !button.disabled)',
      ),
    '恢复技能Host默认策略',
  )
  await clickText('返回技能', 'section[aria-label="技能管理"]')
  await change('搜索技能', '')
  await capture('skills-narrow')
  window.setSize(...originalSize)
  await select('外观')
  await waitFor(() => evaluate('Boolean(document.querySelector("button[aria-label=浅色模式]"))'), '外观页面')
  await evaluate('document.querySelector("button[aria-label=浅色模式]").click()')
  await waitFor(() => evaluate('document.documentElement.dataset.appearance === "light"'), '浅色主题')
  await select('插件')
  await capture('plugins-light')
  await select('技能')
  await capture('skills-light')
  await select('偏好')
  await waitFor(
    () => evaluate('Boolean(document.querySelector("button[aria-label=\\"编辑指令：agents\\"]"))'),
    '浅色偏好',
  )
  await capture('personalization-light')
  await evaluate(`window.piMemePlugins.remove(${JSON.stringify(pluginId)})`)
  await select('插件')
  await waitFor(
    () =>
      evaluate(
        `Boolean(document.querySelector('ul[aria-label="App 插件列表"]')) && !document.querySelector('button[aria-label="查看插件：${pluginId}"]')`,
      ),
    '已移除插件不再出现在资源列表',
  )
  await select('外观')
  await evaluate('document.querySelector("button[aria-label=深色模式]").click()')
  await waitFor(() => evaluate('document.documentElement.dataset.appearance === "dark"'), '恢复深色主题')
}
