const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')

module.exports = async (window, waitFor, outputDirectory) => {
  const evaluate = (code) => window.webContents.executeJavaScript(code)
  const clickText = async (text, scope = 'body') => {
    const find = `Array.from(document.querySelector(${JSON.stringify(scope)}).querySelectorAll('button')).find(node => node.checkVisibility() && !node.disabled && node.textContent.trim() === ${JSON.stringify(text)})`
    await waitFor(() => evaluate(`Boolean(${find})`), `按钮可用：${text}`)
    await evaluate(`${find}.click()`)
  }
  const input = (label, value) => {
    const selector = `input[aria-label="${label}"]`
    return evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, ${JSON.stringify(value)});
      node.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
  }
  const openSelect = async (label) => {
    const selector = `[role="combobox"][aria-label="${label}"]`
    await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), `下拉可用：${label}`)
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selector)}).disabled`), false)
    await evaluate(`(() => {
      const trigger = document.querySelector(${JSON.stringify(selector)});
      trigger.focus();
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`)
    await waitFor(
      () =>
        evaluate(
          `document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-expanded') === 'true' && Boolean(document.querySelector('[role="listbox"] [role="option"]'))`,
        ),
      `下拉展开：${label}`,
    )
  }
  const selectOption = async (label, text) => {
    const selector = `[role="combobox"][aria-label="${label}"]`
    const find = `Array.from(document.querySelectorAll('[role="listbox"] [role="option"]')).find(node => node.textContent.trim() === ${JSON.stringify(text)})`
    await waitFor(() => evaluate(`Boolean(${find})`), `选项可用：${text}`)
    await evaluate(`${find}.click()`)
    await waitFor(
      () =>
        evaluate(
          `(() => { const trigger = document.querySelector(${JSON.stringify(selector)}); return trigger.textContent.trim() === ${JSON.stringify(text)} && trigger.getAttribute('aria-expanded') === 'false'; })()`,
        ),
      `选项生效：${label}`,
    )
  }
  const capture = async (name) => {
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    await fs.writeFile(path.join(outputDirectory, `${name}.png`), (await window.webContents.capturePage()).toPNG())
  }
  const settingsNavigation = 'nav[aria-label="设置分类"]'
  const originalSize = window.getSize()
  await fs.mkdir(outputDirectory, { recursive: true })
  try {
    if (!(await evaluate('Boolean(document.querySelector("section[aria-label=设置页面]"))'))) {
      await evaluate('document.querySelector("button[aria-label=设置]").click()')
    }
    await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(settingsNavigation)}))`), '设置分类')
    await clickText('外观', settingsNavigation)
    await waitFor(
      () => evaluate('document.querySelector("[role=combobox][aria-label=强调色]")?.textContent.trim() === "主题默认"'),
      '强调色默认标签',
    )
    assert.equal(
      await evaluate(`(() => {
        const trigger = document.querySelector('[role="combobox"][aria-label="强调色"]');
        const bounds = trigger.getBoundingClientRect();
        const text = trigger.firstElementChild.getBoundingClientRect();
        const arrow = trigger.querySelector('svg').getBoundingClientRect();
        return arrow.left - text.right >= 10 && bounds.right - arrow.right >= 10 && text.left - bounds.left >= 10;
      })()`),
      true,
      '下拉文字与箭头、箭头与边缘保留至少 10px 间距',
    )
    const originalAccent = await evaluate(
      'getComputedStyle(document.documentElement).getPropertyValue("--color-accent").trim()',
    )
    await openSelect('强调色')
    await selectOption('强调色', '蓝')
    await waitFor(
      () =>
        evaluate('getComputedStyle(document.documentElement).getPropertyValue("--color-accent").trim() === "#3b82f6"'),
      '蓝色强调色实时预览',
    )
    await waitFor(
      () =>
        evaluate(
          'window.piMemeClient.getSettings().then(snapshot => snapshot.settings.appearance?.shared.colors?.accent === "#3b82f6")',
        ),
      '蓝色强调色保存',
    )
    await openSelect('强调色')
    await selectOption('强调色', '主题默认')
    await waitFor(
      () =>
        evaluate(
          `getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim() === ${JSON.stringify(originalAccent)}`,
        ),
      '恢复主题默认强调色',
    )
    await waitFor(
      () =>
        evaluate(
          'window.piMemeClient.getSettings().then(snapshot => Boolean(snapshot.settings.appearance) && snapshot.settings.appearance.shared.colors?.accent === undefined)',
        ),
      '清除强调色覆盖值',
    )
    await openSelect('强调色')
    await capture('select-appearance-menu')
    await selectOption('强调色', '主题默认')

    await clickText('服务连接', settingsNavigation)
    const initialMcp = await evaluate('window.piMemeClient.getMcpConfig()')
    await clickText('新增 MCP 服务')
    await waitFor(
      () => evaluate('Boolean(document.querySelector("form[aria-label=\\"MCP 服务编辑\\"]"))'),
      'MCP 草稿表单',
    )
    await input('MCP URL', 'https://example.invalid/mcp')
    await openSelect('MCP 连接类型')
    await capture('select-controls-mcp-open')
    await selectOption('MCP 连接类型', 'stdio 本地进程')
    assert.equal(
      await evaluate(
        'Boolean(document.querySelector("input[aria-label=可执行命令]")) && !document.querySelector("input[aria-label=\\"MCP URL\\"]")',
      ),
      true,
      '切换到 stdio 后显示本地命令字段',
    )
    await input('可执行命令', 'node')
    await openSelect('MCP 连接类型')
    await selectOption('MCP 连接类型', 'HTTP')
    assert.equal(
      await evaluate(
        'document.querySelector("input[aria-label=\\"MCP URL\\"]").value === "" && !document.querySelector("input[aria-label=可执行命令]")',
      ),
      true,
      '切回 HTTP 后清空地址并移除本地命令字段',
    )
    await clickText('取消编辑', 'form[aria-label="MCP 服务编辑"]')
    await waitFor(() => evaluate('!document.querySelector("form[aria-label=\\"MCP 服务编辑\\"]")'), '取消 MCP 草稿')
    assert.deepEqual(await evaluate('window.piMemeClient.getMcpConfig()'), initialMcp, '取消 MCP 草稿不保存配置')

    await clickText('模型', settingsNavigation)
    const initialModels = await evaluate('window.piMemeClient.getModelConfig()')
    await clickText('添加服务商')
    await waitFor(
      () => evaluate('Boolean(document.querySelector("[aria-label=模型服务商配置]"))'),
      '模型服务商草稿表单',
    )
    await evaluate(`(() => {
      const details = document.querySelector('[role="combobox"][aria-label="API 协议"]').closest('details');
      if (!details.open) details.querySelector('summary').click();
    })()`)
    window.setSize(720, 560)
    await waitFor(() => evaluate('window.innerWidth <= 720'), '窄窗口下拉布局')
    await waitFor(
      () =>
        evaluate(
          'document.querySelector("[aria-label=\\"API 协议\\"]").textContent.trim() === "OpenAI Chat Completions"',
        ),
      '长 API 协议文本',
    )
    assert.equal(
      await evaluate(`(() => {
        const trigger = document.querySelector('[role="combobox"][aria-label="API 协议"]');
        const viewport = document.querySelector('[aria-label="模型配置内容"] [data-radix-scroll-area-viewport]');
        const bounds = trigger.getBoundingClientRect();
        return trigger.scrollWidth <= trigger.clientWidth + 1 && viewport.scrollWidth <= viewport.clientWidth + 1 && bounds.left >= 0 && bounds.right <= window.innerWidth;
      })()`),
      true,
      '窄窗口的长 API 协议文本和表单不横向溢出',
    )
    await capture('select-controls-api-small')
    await openSelect('API 协议')
    await capture('select-controls-api-open')
    const apiMenuLayout = await evaluate(`(() => {
      const listbox = document.querySelector('[role="listbox"]');
      const bounds = listbox.getBoundingClientRect();
      return { scrollWidth: listbox.scrollWidth, clientWidth: listbox.clientWidth, left: bounds.left, right: bounds.right, windowWidth: window.innerWidth };
    })()`)
    assert.equal(
      apiMenuLayout.scrollWidth <= apiMenuLayout.clientWidth + 1 &&
        apiMenuLayout.left >= 0 &&
        apiMenuLayout.right <= apiMenuLayout.windowWidth,
      true,
      `API 协议菜单不横向溢出：${JSON.stringify(apiMenuLayout)}`,
    )
    await selectOption('API 协议', 'Google Generative AI')
    await clickText('取消', '[aria-label="模型服务商配置"]')
    await waitFor(
      () => evaluate('Boolean(document.querySelector("[aria-label=放弃模型配置修改]"))'),
      'API 修改触发未保存草稿提示',
    )
    await clickText('放弃修改', '[aria-label="放弃模型配置修改"]')
    await waitFor(() => evaluate('!document.querySelector("[aria-label=模型服务商配置]")'), '放弃模型服务商草稿')
    assert.deepEqual(await evaluate('window.piMemeClient.getModelConfig()'), initialModels, '取消 API 草稿不保存配置')
    await clickText('返回聊天')
    await waitFor(() => evaluate('!document.querySelector("section[aria-label=设置页面]")'), '返回聊天')
  } finally {
    window.setSize(...originalSize)
  }
}
