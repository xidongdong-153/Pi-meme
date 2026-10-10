const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')

module.exports = async function personalizationSmoke(window, waitFor, directory, screenshots) {
  const evaluate = (code) =>
    window.webContents.executeJavaScript(code).catch((error) => {
      console.error('个性化验收脚本执行失败：', code, error)
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
    await clickText(name, nav)
    await waitFor(
      () => evaluate(`document.querySelector('nav [aria-current=page]')?.textContent === ${JSON.stringify(name)}`),
      `设置分类：${name}`,
    )
  }
  const originalSize = window.getSize()
  await select('个性化')
  await waitFor(
    () => evaluate('Boolean(document.querySelector("button[aria-label=\\"编辑指令：agents\\"]"))'),
    '个性化指令',
  )
  await capture('personalization-dark')
  await evaluate('document.querySelector("button[aria-label=默认访问权限]").click()')
  await waitFor(
    () => evaluate('document.querySelector("nav [aria-current=page]").textContent === "访问权限"'),
    '访问权限入口',
  )
  await select('个性化')
  await waitFor(
    () => evaluate('Boolean(document.querySelector("button[aria-label=\\"编辑指令：agents\\"]"))'),
    '返回个性化',
  )
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
  await select('Host 连接')
  assert.equal(await evaluate('document.querySelector("#settings-content").textContent.includes("本地主机")'), true)
  assert.equal(await evaluate('Boolean(document.querySelector("#settings-content input[type=password]"))'), false)
  await select('插件')
  await waitFor(() => evaluate('document.querySelectorAll("ul[aria-label=已安装插件] li").length === 14'), '插件列表')
  await change('搜索插件', '不存在的插件')
  await waitFor(() => evaluate('document.querySelectorAll("ul[aria-label=已安装插件] li").length === 0'), '插件搜索')
  await change('搜索插件', '')
  await capture('plugins-dark')
  await evaluate('document.querySelector("button[aria-label=\\"查看插件：@pi-meme/settings\\"]").click()')
  await waitFor(
    () => evaluate('document.querySelector("[role=dialog]").textContent.includes("@pi-meme/settings")'),
    '插件详情',
  )
  await evaluate('document.querySelector("[role=dialog] > button:last-child").click()')
  await waitFor(() => evaluate('!document.querySelector("[role=dialog]")'), '关闭插件详情')
  await evaluate(
    'document.querySelector("button[aria-label=\\"管理插件：@pi-meme/settings\\"]").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))',
  )
  await waitFor(() => evaluate('Boolean(document.querySelector("[role=menu]"))'), '插件操作菜单')
  await clickText('停用', '[role=menu]')
  await waitFor(
    () => evaluate('document.querySelector("ul[aria-label=已安装插件]").textContent.includes("已停用")'),
    '设置插件停用',
  )
  await clickText('已停用', '#settings-content')
  await waitFor(() => evaluate('document.querySelectorAll("ul[aria-label=已安装插件] li").length === 1'), '已停用筛选')
  await clickText('已启用', '#settings-content')
  await waitFor(() => evaluate('document.querySelectorAll("ul[aria-label=已安装插件] li").length === 13'), '已启用筛选')
  await select('Host 连接')
  assert.equal(
    await evaluate('document.querySelector("#settings-content").textContent.includes("连接其他 Host")'),
    true,
  )
  await select('插件')
  await evaluate('window.piMemePlugins.enable("@pi-meme/settings")')
  await waitFor(
    () =>
      evaluate(
        'window.piMemePlugins.list().then(items => items.find(item => item.id === "@pi-meme/settings").enabled)',
      ),
    '设置插件重新启用',
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
  await change('搜索技能', 'review-code')
  await waitFor(() => evaluate('document.querySelectorAll("ul[aria-label=已加载技能] li").length === 1'), '技能搜索')
  await clickText('项目', '#settings-content')
  assert.equal(await evaluate('document.querySelectorAll("ul[aria-label=已加载技能] li").length'), 0)
  await clickText('全部', '#settings-content')
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
  await select('个性化')
  await waitFor(
    () => evaluate('Boolean(document.querySelector("button[aria-label=\\"编辑指令：agents\\"]"))'),
    '浅色个性化',
  )
  await capture('personalization-light')
  await select('外观')
  await evaluate('document.querySelector("button[aria-label=深色模式]").click()')
  await waitFor(() => evaluate('document.documentElement.dataset.appearance === "dark"'), '恢复深色主题')
}
