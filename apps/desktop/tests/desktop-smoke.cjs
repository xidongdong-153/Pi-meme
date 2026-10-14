const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { openTool } = require('./tool-tabs-smoke.cjs')
const { app, BrowserWindow } = require('electron')

if (process.env.PI_DESKTOP_DEV_SERVER_URL) {
  BrowserWindow.prototype.loadFile = function () {
    return this.loadURL(process.env.PI_DESKTOP_DEV_SERVER_URL)
  }
}

const root = path.resolve(__dirname, '..')
const directory = fsSync.realpathSync(fsSync.mkdtempSync(path.join(os.tmpdir(), 'pi-desktop-smoke-')))
const profileDirectory = path.join(directory, 'desktop-cache')
fsSync.mkdirSync(profileDirectory)
app.setPath('userData', profileDirectory)
app.commandLine.appendSwitch('user-data-dir', profileDirectory)
process.env.PI_MEME_DATA_ROOT = directory
process.env.PI_MEME_TEST_CREDENTIALS = 'file'
let gitDirectory
let failed = false
let smokeAgent
async function waitFor(check, label = '界面状态') {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`桌面验收等待超时：${label}`)
}
const smokePluginId = '@pi-meme-fixtures/desktop-smoke'
async function prepareSmokeApp(window, installAgent = true) {
  const evaluate = (code) => window.webContents.executeJavaScript(code)
  await waitFor(() => evaluate('Boolean(window.piMemeClient && window.piPlatform)'), 'Host 客户端初始化')
  await evaluate(`(async () => {
    const connection = await window.piPlatform.getHostConnection();
    window.smokeRpc = async (method,args = [],sessionId) => {
      const response = await fetch(new URL('/api/rpc',connection.url),{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:crypto.randomUUID(),clientId:'desktop-smoke-admin',method,args,sessionId})});
      const value = await response.json(); if (!response.ok || value.error) throw new Error(value.error?.message || 'Host 操作失败'); return value.result;
    };
    window.smokeControl = async (method,args = [],mutation = false) => {
      const response = await fetch(new URL('/api/control',connection.url),{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({apiVersion:2,clientId:'desktop-smoke-admin',method,args,...(mutation ? {idempotencyKey:crypto.randomUUID()} : {})})});
      const value = await response.json(); if (!response.ok || value.error) throw new Error(value.error?.message || 'Host 控制操作失败'); return value.result;
    };
    if (!${JSON.stringify(installAgent)}) return;
    await window.smokeRpc('plugins:install-directory',[${JSON.stringify(path.join(directory, 'smoke-app'))}]);
    await window.smokeControl('plugins.setDefaultAgentPlugins',[[${JSON.stringify(smokePluginId)}]],true);
    const connectionState = await window.piMemeClient.getConnection();
    if (connectionState.sessionKey) {
      const session = await window.piMemeClient.resolveAppSession(connectionState.sessionKey);
      await window.smokeControl('sessions.configure',[{hostId:session.hostId,sessionId:session.sessionId},{agentPlugins:[${JSON.stringify(smokePluginId)}]}],true);
    }
  })()`)
}
async function runAppPlugins(window) {
  const evaluate = (code) => window.webContents.executeJavaScript(code)
  const clickText = (text, scope = 'body') =>
    evaluate(`(() => {
    const button = [...document.querySelector(${JSON.stringify(scope)}).querySelectorAll('button')].find(node => node.checkVisibility() && node.textContent.trim() === ${JSON.stringify(text)});
    if (!button) throw new Error('未找到按钮：' + ${JSON.stringify(text)}); button.click();
  })()`)
  const capture = async (name) => {
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    await evaluate('new Promise(resolve => setTimeout(resolve,250))')
    await fs.writeFile(
      path.join(root, 'out', 'desktop-smoke', `${name}.png`),
      (await window.webContents.capturePage()).toPNG(),
    )
  }
  const repository = path.resolve(root, '..', '..')
  for (const name of ['theme-landscape']) {
    const pluginDirectory = path.join(repository, 'plugins', name)
    const manifest = JSON.parse(await fs.readFile(path.join(pluginDirectory, 'package.json'), 'utf8'))
    if (manifest.piMeme.ui) await fs.access(path.join(pluginDirectory, manifest.piMeme.ui))
    await evaluate(`window.smokeRpc('plugins:install-directory',[${JSON.stringify(pluginDirectory)}])`)
  }
  const installed = await evaluate(`window.smokeRpc('plugins:list')`)
  for (const id of ['@pi-meme/file-directory', '@pi-meme/terminal', '@pi-meme/theme-landscape']) {
    assert.ok(
      installed.some((plugin) => plugin.id === id && plugin.enabled && plugin.status === 'active'),
      `插件已实际启用：${id}`,
    )
  }
  const capabilities = await evaluate(`window.smokeControl('capabilities')`)
  assert.ok(capabilities.features.includes('files'), '专项验收要求 Host 文件接口可用')
  assert.ok(capabilities.features.includes('terminal'), '专项验收要求真实 PTY 可用')
  await evaluate(`window.piMemeClient.chooseDirectory(${JSON.stringify(gitDirectory)})`)
  await waitFor(
    () =>
      evaluate(
        `window.piMemeClient.getConnection().then(value => value.cwd === ${JSON.stringify(gitDirectory)} && Boolean(value.sessionKey))`,
      ),
    '示范插件项目与会话目标',
  )
  await evaluate(`document.querySelector('button[aria-label="设置"]').click()`)
  await waitFor(() => evaluate(`Boolean(document.querySelector('nav[aria-label="设置分类"]'))`), '独立设置导航')
  assert.deepEqual(
    await evaluate(
      `[...document.querySelectorAll('nav[aria-label="设置分类"] section[aria-label="集成"] button')].map(node => node.textContent.trim())`,
    ),
    ['技能', '插件', 'MCP'],
  )
  await clickText('技能', 'nav[aria-label="设置分类"]')
  await waitFor(() => evaluate(`Boolean(document.querySelector('section[aria-label="技能管理"]'))`), '独立技能页面')
  assert.equal(
    await evaluate(`document.querySelector('section[aria-label="技能管理"] [aria-label="资源类型"]') === null`),
    true,
  )
  assert.equal(
    await evaluate(`document.querySelector('section[aria-label="技能管理"]').textContent.includes('安装插件包')`),
    false,
  )
  await capture('app-plugins-skills')
  await clickText('插件', 'nav[aria-label="设置分类"]')
  await waitFor(
    () => evaluate(`document.querySelectorAll('ul[aria-label="App 插件列表"] li').length === 1`),
    '主题 App 插件列表',
  )
  assert.equal(
    await evaluate(`document.querySelector('section[aria-label="插件管理"] [aria-label="资源类型"]') === null`),
    true,
  )
  assert.equal(
    await evaluate(`document.querySelector('section[aria-label="插件管理"]').textContent.includes('新建技能')`),
    false,
  )
  await capture('app-plugins-list')
  await clickText('MCP', 'nav[aria-label="设置分类"]')
  await waitFor(
    () => evaluate(`document.querySelector('#settings-content h2')?.textContent === 'MCP'`),
    '独立 MCP 页面',
  )
  await capture('app-plugins-mcp')
  await clickText('外观', 'nav[aria-label="设置分类"]')
  await waitFor(() => evaluate(`Boolean(document.querySelector('button[aria-label="深色模式"]'))`), '主题设置')
  await evaluate(`document.querySelector('button[aria-label="深色模式"]').click()`)
  const themeSelector = '[role="combobox"][aria-label="外观主题"]'
  await evaluate(
    `document.querySelector(${JSON.stringify(themeSelector)}).dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`,
  )
  await waitFor(
    () => evaluate(`[...document.querySelectorAll('[role="option"]')].some(node => node.textContent.includes('山色'))`),
    '山色主题选项',
  )
  await evaluate(
    `[...document.querySelectorAll('[role="option"]')].find(node => node.textContent.includes('山色')).click()`,
  )
  await waitFor(() => evaluate(`document.documentElement.dataset.themeBackground === 'workspace'`), '山色主题背景应用')
  const image = await evaluate(`(async () => {
    const style = getComputedStyle(document.querySelector('.theme-workspace'),'::before');
    const url = style.backgroundImage.slice(4,-1).replace(/^"|"$/g,'');
    const image = new Image(); image.src = url; await image.decode();
    return {width:image.naturalWidth,height:image.naturalHeight,url,opacity:Number(style.opacity)};
  })()`)
  assert.ok(image.width > 0 && image.height > 0 && image.opacity > 0, '主题背景资产已加载且可见')
  assert.ok(image.url.includes('/api/plugins/'), '主题图片来自认证插件资源接口')
  await capture('app-plugins-theme')
  await clickText('返回聊天')
  const assertFixedChat = async () => {
    assert.equal(
      await evaluate(`(() => {
        const chat = document.querySelector('#chat-workspace');
        return chat?.checkVisibility() && chat.getBoundingClientRect().width > 0;
      })()`),
      true,
      '聊天始终可见',
    )
    assert.equal(
      await evaluate(`document.querySelector('#workspace-sidebar [role="tablist"]') === null`),
      true,
      '左栏没有插件页签',
    )
    assert.equal(
      await evaluate(`document.querySelector('#workspace-sidebar [role="tabpanel"]') === null`),
      true,
      '左栏只有内置会话导航',
    )
    assert.equal(
      await evaluate(`document.querySelector('#chat-workspace [role="tabpanel"]') === null`),
      true,
      '插件工具不替换聊天',
    )
    assert.equal(
      await evaluate(
        `[...document.querySelectorAll('summary')].some(node => node.checkVisibility() && node.textContent.trim() === '面板')`,
      ),
      false,
      '不存在旧面板菜单',
    )
    assert.equal(
      await evaluate(`document.querySelector('[role="tablist"][aria-label="底部面板"]') === null`),
      true,
      '不存在底部插件区域',
    )
  }
  await evaluate(`document.querySelector('button[aria-label="展开右侧栏"]')?.click()`)
  await waitFor(
    () =>
      evaluate(`Boolean(document.querySelector('#workspace-right-sidebar [role="tabpanel"][aria-label="新标签页"]'))`),
    '默认工具选择页',
  )
  await assertFixedChat()
  await capture('app-plugins-tool-picker')
  const regularWidth = await evaluate(
    `document.querySelector('#workspace-right-sidebar').getBoundingClientRect().width`,
  )
  await evaluate(`document.querySelector('button[aria-label="加宽右侧栏"]').click()`)
  await waitFor(
    () => evaluate(`Boolean(document.querySelector('button[aria-label="还原右侧栏宽度"]'))`),
    '右侧工具栏加宽',
  )
  assert.ok(
    (await evaluate(`document.querySelector('#workspace-right-sidebar').getBoundingClientRect().width`)) >=
      regularWidth,
    '加宽工具栏保留可见聊天区域',
  )
  await assertFixedChat()
  await capture('app-plugins-tool-picker-wide')
  await evaluate(`document.querySelector('button[aria-label="还原右侧栏宽度"]').click()`)
  await waitFor(
    () =>
      evaluate(`document.querySelector('#workspace-right-sidebar').getBoundingClientRect().width === ${regularWidth}`),
    '还原工具栏宽度',
  )
  await openTool(window, waitFor, '文件')
  await waitFor(
    () => evaluate(`document.querySelector('[role="tabpanel"][aria-label="文件"]')?.textContent.includes('README.md')`),
    '真实项目文件目录',
  )
  await assertFixedChat()
  await capture('app-plugins-directory')
  await clickText('README.md', '[role="tabpanel"][aria-label="文件"]')
  await waitFor(
    () =>
      evaluate(
        `document.querySelector('[role="tabpanel"][aria-label="文件"] .cm-content')?.textContent.includes('# 验收项目')`,
      ),
    '点击文件在同一面板打开编辑器',
  )
  await assertFixedChat()
  await capture('app-plugins-preview')
  await openTool(window, waitFor, '变更')
  await waitFor(
    () => evaluate(`Boolean(document.querySelector('#workspace-right-sidebar [role="tabpanel"][aria-label="变更"]'))`),
    '内置 Git 右侧面板',
  )
  await openTool(window, waitFor, '终端')
  await evaluate(`(() => {
    const originalJson = Response.prototype.json;
    Response.prototype.json = async function () {
      const value = await originalJson.call(this);
      if (value.result?.terminalId) {
        window.smokeTerminalRef = value.result;
        Response.prototype.json = originalJson;
      }
      return value;
    };
  })()`)
  await clickText('创建终端', '[role="tabpanel"][aria-label="终端"]')
  await waitFor(
    () =>
      evaluate(
        `Boolean(window.smokeTerminalRef && document.querySelector('[role="tabpanel"][aria-label="终端"] .xterm-screen canvas')) && document.activeElement===document.querySelector('[role="tabpanel"][aria-label="终端"] .xterm-helper-textarea')`,
      ),
    '示范终端真实挂载',
  )
  await evaluate(`document.querySelector('[role="tabpanel"][aria-label="终端"] .xterm-helper-textarea').focus()`)
  await window.webContents.insertText("printf '\\101\\120\\120\\137\\120\\114\\125\\107\\111\\116\\137\\117\\113\\n'")
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
  await waitFor(
    () =>
      evaluate(
        `window.smokeControl('terminal.attach',[window.smokeTerminalRef]).then(value=>value.output.includes('APP_PLUGIN_OK'))`,
      ),
    '真实 PTY 输入与回显',
  )
  const terminalSize = await evaluate(`window.smokeControl('terminal.attach',[window.smokeTerminalRef])`)
  const codeSize = await evaluate(`document.documentElement.style.getPropertyValue('--code-size')`)
  await evaluate(`document.documentElement.style.setProperty('--code-size','24px')`)
  await waitFor(
    () =>
      evaluate(
        `window.smokeControl('terminal.attach',[window.smokeTerminalRef]).then(value=>value.cols<${terminalSize.cols} && value.rows<${terminalSize.rows})`,
      ),
    '字号变化后同步 PTY 行列数',
  )
  await evaluate(`document.documentElement.style.setProperty('--code-size',${JSON.stringify(codeSize)})`)
  await waitFor(
    () =>
      evaluate(
        `window.smokeControl('terminal.attach',[window.smokeTerminalRef]).then(value=>value.cols===${terminalSize.cols} && value.rows===${terminalSize.rows})`,
      ),
    '恢复终端字号和 PTY 行列数',
  )
  await assertFixedChat()
  const terminalControls = await evaluate(`(() => {
    const panel = document.querySelector('#workspace-right-sidebar');
    const bounds = panel.getBoundingClientRect();
    return [...panel.querySelectorAll('button')].filter(node=>/重新连接终端|关闭终端实例/.test(node.getAttribute('aria-label') || '')).map(node=>{
      const rect = node.getBoundingClientRect();
      return {title:node.getAttribute('aria-label'),left:rect.left,right:rect.right,panelLeft:bounds.left,panelRight:bounds.right};
    });
  })()`)
  assert.equal(terminalControls.length, 2, '终端连接与关闭操作可用')
  for (const control of terminalControls)
    assert.ok(
      control.left >= control.panelLeft && control.right <= control.panelRight,
      `终端操作完整显示：${JSON.stringify(control)}`,
    )
  await capture('app-plugins-terminal')
  const selectedTab = () =>
    evaluate(
      `document.querySelector('[role="tablist"][aria-label="右侧栏标签"] [role="tab"][aria-selected="true"]')?.textContent.trim()`,
    )
  const terminalTitle = await selectedTab()
  await evaluate(`document.querySelector('button[aria-label="收起右侧栏"]').click()`)
  await waitFor(() => evaluate(`document.querySelector('#workspace-right-sidebar') === null`), '右侧工具栏收起')
  await assertFixedChat()
  await evaluate(`document.querySelector('button[aria-label="展开右侧栏"]').click()`)
  await waitFor(async () => (await selectedTab()) === terminalTitle, '展开保留当前工具标签')
  await openTool(window, waitFor, '变更')
  await capture('app-plugins-tabs-git')
  await evaluate(`document.querySelector('button[aria-label="关闭标签页：变更"]').click()`)
  await waitFor(
    () =>
      evaluate(
        `[...document.querySelectorAll('[role="tablist"][aria-label="右侧栏标签"] [role="tab"]')].every(node=>!node.textContent.includes('变更'))`,
      ),
    '关闭 Git 标签',
  )
  await openTool(window, waitFor, '变更')
  await assertFixedChat()
  await capture('app-plugins-tabs-reopened')
  const firstSession = await evaluate(`window.piMemeClient.getConnection()`)
  await evaluate(
    `window.piMemeClient.setModel(${JSON.stringify(firstSession.sessionKey)},{provider:'fake',id:'first'})`,
  )
  await evaluate(`window.piMemeClient.prompt(${JSON.stringify(firstSession.sessionKey)},'右侧工具会话隔离验收')`)
  await waitFor(
    () =>
      evaluate(
        `window.piMemeClient.getSnapshot().then(value=>Boolean(value.connection.sessionFile)&&!value.state.isStreaming)`,
      ),
    '首会话落盘',
  )
  const firstFile = await evaluate(`window.piMemeClient.getConnection().then(value=>value.sessionFile)`)
  const firstTabs = await evaluate(
    `[...document.querySelectorAll('[role="tablist"][aria-label="右侧栏标签"] [role="tab"]')].map(node=>node.textContent.trim())`,
  )
  const firstActive = await selectedTab()
  await evaluate(`window.piMemeClient.newSession()`)
  await waitFor(
    () =>
      evaluate(
        `window.piMemeClient.getConnection().then(value=>value.sessionKey!==${JSON.stringify(firstSession.sessionKey)})`,
      ),
    '新会话拥有独立身份',
  )
  await evaluate(`document.querySelector('button[aria-label="展开右侧栏"]')?.click()`)
  await waitFor(
    () =>
      evaluate(`Boolean(document.querySelector('#workspace-right-sidebar [role="tabpanel"][aria-label="新标签页"]'))`),
    '新会话从工具选择页开始',
  )
  await waitFor(
    () =>
      evaluate(
        `document.querySelector('#workspace-right-sidebar [role="tabpanel"][aria-label="新标签页"]')?.textContent.includes('终端')`,
      ),
    '新会话稳定目标与工具选择完成',
  )
  assert.equal(
    await evaluate(
      `[...document.querySelectorAll('[role="tablist"][aria-label="右侧栏标签"] [role="tab"]')].some(node=>/变更|文件|终端/.test(node.textContent))`,
    ),
    false,
    '新会话不继承旧会话工具标签',
  )
  await openTool(window, waitFor, '文件')
  await assertFixedChat()
  await capture('app-plugins-session-new')
  await evaluate(`window.piMemeClient.switchSession(${JSON.stringify(firstFile)})`)
  await waitFor(
    () => evaluate(`window.piMemeClient.getConnection().then(value=>value.sessionFile===${JSON.stringify(firstFile)})`),
    '恢复首会话',
  )
  await evaluate(`document.querySelector('button[aria-label="展开右侧栏"]')?.click()`)
  await waitFor(async () => (await selectedTab()) === firstActive, '恢复原会话当前工具')
  assert.deepEqual(
    await evaluate(
      `[...document.querySelectorAll('[role="tablist"][aria-label="右侧栏标签"] [role="tab"]')].map(node=>node.textContent.trim())`,
    ),
    firstTabs,
    '原会话标签列表完整恢复',
  )
  await assertFixedChat()
  await capture('app-plugins-session-restored')
  await openTool(window, waitFor, '终端')
  await waitFor(
    () =>
      evaluate(
        `Boolean(document.querySelector('#workspace-right-sidebar [aria-label="终端"] .xterm-screen canvas')) && window.smokeControl('terminal.attach',[window.smokeTerminalRef]).then(value=>value.output.includes('APP_PLUGIN_OK'))`,
      ),
    '切换标签及会话后保留原终端输出',
  )
  await capture('app-plugins-terminal-restored')
  await evaluate(`document.querySelector('button[aria-label="关闭终端实例"]').click()`)
  await evaluate(`document.querySelector('button[aria-label="设置"]').click()`)
  await clickText('外观', 'nav[aria-label="设置分类"]')
  await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(themeSelector)}))`), '恢复内置深色主题')
  await evaluate(
    `document.querySelector(${JSON.stringify(themeSelector)}).dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`,
  )
  await waitFor(
    () =>
      evaluate(`[...document.querySelectorAll('[role="option"]')].some(node => node.textContent.trim() === '深色')`),
    '内置深色主题选项',
  )
  await evaluate(
    `[...document.querySelectorAll('[role="option"]')].find(node => node.textContent.trim() === '深色').click()`,
  )
  await waitFor(
    () => evaluate(`document.documentElement.dataset.themeBackground !== 'workspace'`),
    '默认深色主题清除背景图片',
  )
  await clickText('返回聊天')
  await evaluate(`window.piMemeClient.newSession()`)
  await evaluate(`document.querySelector('button[aria-label="展开右侧栏"]')?.click()`)
  await waitFor(
    () =>
      evaluate(`Boolean(document.querySelector('#workspace-right-sidebar [role="tabpanel"][aria-label="新标签页"]'))`),
    '默认深色三栏工具选择页',
  )
  await waitFor(
    () =>
      evaluate(
        `document.querySelector('#workspace-right-sidebar [aria-label="新标签页"]')?.textContent.includes('终端')`,
      ),
    '深色总览工具目录加载',
  )
  await assertFixedChat()
  await capture('app-plugins-dark-overview')
  console.log(
    'App 插件专项验收通过：固定左栏与聊天、独立设置、山色背景、右侧工具标签切换关闭重开、终端回显、会话标签隔离',
  )
}
async function run(window) {
  assert.equal(window.webContents.session.isPersistent(), false, '应用使用内存 Session')
  assert.equal(window.webContents.session.storagePath, null, '认证 Cookie 不依赖磁盘加密或钥匙串')
  const evaluate = (code) =>
    window.webContents.executeJavaScript(code).catch((error) => {
      console.error('桌面验收脚本执行失败：', code, error)
      throw error
    })
  if (process.env.PI_DESKTOP_SIDEBAR_MENU_SMOKE_ONLY === '1') {
    window.show()
    window.focus()
    window.webContents.focus()
    await waitFor(() => evaluate('document.hasFocus()'), '侧栏专项验收窗口获得焦点')
  }
  const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const assertImageLoaded = async (selector, label) => {
    await waitFor(() => evaluate(`document.querySelector(${JSON.stringify(selector)})?.complete === true`), label)
    assert.equal(
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).naturalWidth > 0`),
      true,
      `${label}应成功解码并显示`,
    )
  }
  const clickText = (text, scope = 'body') =>
    evaluate(
      `(() => { const root = document.querySelector(${JSON.stringify(scope)}); const button = [...root.querySelectorAll('button')].find(node => node.textContent.trim() === ${JSON.stringify(text)}); if (!button) throw new Error('未找到按钮：' + ${JSON.stringify(text)}); button.click(); })()`,
    )
  const setDraft = (value) =>
    evaluate(
      `(() => { const input = document.querySelector('[contenteditable=true][aria-label="消息"]'); input.textContent = ${JSON.stringify(value)}; input.focus(); const range = document.createRange(); range.selectNodeContents(input); range.collapse(false); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
    )
  const dialog = '[role="region"][aria-label="Agent 提问"]'
  const waitTitle = (title) =>
    waitFor(
      () =>
        evaluate(
          `document.querySelector(${JSON.stringify(dialog)})?.querySelector('h2')?.textContent === ${JSON.stringify(title)}`,
        ),
      `App 插件提问：${title}`,
    )
  const choose = async (selector, text) => {
    await evaluate(
      `document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`,
    )
    await waitFor(
      () =>
        evaluate(
          `[...document.querySelectorAll('[role="option"]')].some(node => node.textContent.includes(${JSON.stringify(text)}))`,
        ),
      `下拉选项：${text}`,
    )
    await evaluate(
      `(() => { const option = [...document.querySelectorAll('[role="option"]')].find(node => node.textContent.includes(${JSON.stringify(text)})); option.click(); })()`,
    )
    await waitFor(
      () => evaluate(`document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-expanded') === 'false'`),
      '下拉关闭',
    )
  }
  const capture = async (name) => {
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    await fs.writeFile(
      path.join(root, 'out', 'desktop-smoke', `${name}.png`),
      (await window.webContents.capturePage()).toPNG(),
    )
  }
  await waitFor(
    () => evaluate('window.piMemeClient?.getConnection().then(connection => connection.status === "idle")'),
    '初始空白页不启动运行时',
  )
  await waitFor(
    () => evaluate('Boolean(document.querySelector("[contenteditable=true][aria-label=消息]"))'),
    '共享聊天界面加载完成',
  )
  assert.equal(
    await evaluate('window.piMemeClient.getConnection().then(connection => connection.workspaceKind)'),
    'standalone',
  )
  await waitFor(
    () => evaluate(`Boolean(document.querySelector('[aria-label="选择当前项目"]'))`),
    '项目选择入口加载完成',
  )
  assert.equal(
    await evaluate(`document.querySelector('[aria-label="选择当前项目"]')?.textContent.includes('不在项目中工作')`),
    true,
  )
  const builtinSkillPath = path.join(directory, 'builtin-resources', 'skills', 'skill-creator', 'SKILL.md')
  const creator = await evaluate(
    'window.piMemeClient.getCommands().then(commands => commands.find(command => command.name === "skill:skill-creator"))',
  )
  assert.equal(creator?.displayName, 'Skill Creator', '安装后无需创建技能即可读取 Skill Creator')
  assert.equal(creator?.builtin, true, 'Skill Creator 标记为内置技能')
  assert.ok(creator?.resourceId && creator?.resourceRevision, '技能命令提供稳定资源身份')
  assert.ok(
    creator?.sourceInfo.path.startsWith(path.join(directory, 'resources', 'snapshots')),
    '技能命令指向完整修订快照',
  )
  assert.ok(await fs.stat(builtinSkillPath), '维护来源保存在内置技能目录')
  await setDraft('$')
  const creatorOption = '#composer-suggestions [role=option]'
  await waitFor(
    () =>
      evaluate(
        `[...document.querySelectorAll(${JSON.stringify(creatorOption)})].some(node => node.textContent.includes('Skill Creator') && node.textContent.includes('内置'))`,
      ),
    '$ 内置技能候选',
  )
  await waitFor(async () => {
    const creatorPoint = await evaluate(`(() => {
        const option = [...document.querySelectorAll(${JSON.stringify(creatorOption)})].find(node => node.textContent.includes('Skill Creator'));
        const rect = option.getBoundingClientRect();
        return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      })()`)
    window.webContents.sendInputEvent({ type: 'mouseMove', ...creatorPoint })
    return evaluate(
      `[...document.querySelectorAll('[role=tooltip]')].some(node => node.textContent.includes(${JSON.stringify(creator.sourceInfo.path)}))`,
    )
  }, '技能悬停显示实际 SKILL.md 路径')
  await capture('skill-creator')
  await evaluate(
    `[...document.querySelectorAll(${JSON.stringify(creatorOption)})].find(node => node.textContent.includes('Skill Creator')).click()`,
  )
  await waitFor(
    () =>
      evaluate(
        `document.querySelector('[aria-label="消息"] [data-skill-token="${creator.resourceId}"]')?.textContent === 'Skill Creator'`,
      ),
    '选择技能后使用显示名称',
  )
  assert.equal(
    await evaluate('window.piMemeClient.getConnection().then(connection => connection.status)'),
    'idle',
    '选择内置技能不启动模型或 Worker',
  )
  await setDraft('')
  if (process.env.PI_DESKTOP_PLAN_SMOKE_ONLY === '1') {
    const snapshot = await evaluate('window.piMemeClient.getSnapshot()')
    assert.ok(snapshot.connection.sessionKey, '首次发送前新聊天具有稳定身份')
    assert.equal(snapshot.messages.length, 0, '计划独立验收从零消息新聊天开始')
    assert.equal(snapshot.connection.status, 'idle', '新聊天尚未启动 Worker')
    await waitFor(
      () =>
        evaluate(
          'window.piMemeClient.getSnapshot().then(value => value.models.some(model => model.provider === "fake" && model.id === "first"))',
        ),
      '临时假模型可用',
    )
    if ((await evaluate('window.piMemeClient.getSnapshot()')).state.modelSelectionRequired) {
      const trigger = 'button[aria-label="选择模型与思考强度"]'
      await waitFor(
        () => evaluate(`!document.querySelector(${JSON.stringify(trigger)}).disabled`),
        '冷聊天模型选择可用',
      )
      await click(trigger)
      await waitFor(() => evaluate('Boolean(document.querySelector("[role=slider]"))'), '冷聊天思考强度面板')
      await evaluate(
        '[...document.querySelectorAll("[role=dialog] button")].find(node => !node.getAttribute("aria-label")).click()',
      )
      await waitFor(() => evaluate('Boolean(document.querySelector("[aria-label=可用模型]"))'), '临时假模型列表')
      await evaluate(
        '[...document.querySelectorAll("[aria-label=可用模型] button")].find(node => node.textContent.includes("first")).click()',
      )
      await waitFor(
        () =>
          evaluate(
            `window.piMemeClient.getSnapshot().then(value => value.state.model?.provider === "fake" && value.state.model?.id === "first" && !document.querySelector(${JSON.stringify(trigger)}).disabled)`,
          ),
        '首次发送前选择临时假模型',
      )
      await click(trigger)
      await waitFor(() => evaluate('!document.querySelector("[role=slider]")'), '关闭冷聊天模型选择')
    }
    await fs.mkdir(path.join(root, 'out', 'desktop-smoke'), { recursive: true })
    await require('./plan-composer-smoke.cjs')(window, waitFor, directory, path.join(root, 'out', 'desktop-smoke'), {
      cold: true,
    })
    console.log(
      '计划输入验收通过：冷聊天规范候选、键鼠与输入法、计划标识悬停关闭、保留草稿、首次发送、文档复制导出和普通模式下一轮',
    )
    return
  }
  await setDraft('设置页面保留的草稿')
  await waitFor(() => evaluate(`document.querySelector('[aria-label="发送消息"]')?.disabled === false`), '空白页可发送')
  await click('button[aria-label="设置"]')
  await waitFor(() => evaluate('Boolean(document.querySelector("section[aria-label=设置页面]"))'), '内置运行时设置')
  assert.equal(await evaluate('document.querySelector("#pi-cli-path") === null'), true)
  assert.deepEqual(
    await evaluate(
      '[...document.querySelectorAll("nav[aria-label=设置分类] button")].map(node => node.textContent.trim())',
    ),
    ['模型', '外观', '偏好', '用量', '技能', '插件', 'MCP', '远程', '开发者', '关于'],
  )
  assert.equal(await evaluate('document.querySelector("aside details") === null'), true)
  await clickText('关于')
  await waitFor(() => evaluate('document.body.textContent.includes("随 Host 一起分发")'), '关于运行时内容加载')
  assert.equal(await evaluate('document.querySelector("header button[aria-label=设置]") === null'), true)
  assert.equal(await evaluate('document.querySelectorAll("button[aria-label=设置]").length'), 1)
  await clickText('返回聊天')
  await waitFor(() => evaluate('!document.querySelector("section[aria-label=设置页面]")'), '返回聊天')
  assert.equal(
    await evaluate('document.querySelector("[contenteditable=true][aria-label=消息]").textContent'),
    '设置页面保留的草稿',
  )
  await setDraft('')
  if (process.env.PI_DESKTOP_SELECT_SMOKE_ONLY === '1') {
    await fs.mkdir(path.join(root, 'out', 'desktop-smoke'), { recursive: true })
    await require('./select-controls-smoke.cjs')(window, waitFor, path.join(root, 'out', 'desktop-smoke'))
    await require('./image-viewer-smoke.cjs')(window, waitFor, path.join(root, 'out', 'desktop-smoke'))
    console.log('下拉桌面验收通过：主题间距、表单选择、长标签、图片缩放与键盘焦点')
    return
  }
  if (process.env.PI_DESKTOP_MCP_SMOKE_ONLY === '1') {
    await require('./mcp-smoke.cjs')(window, waitFor, path.join(root, 'out', 'desktop-smoke'))
    console.log('MCP 桌面验收通过：表单、高级 JSON、启停、逐服务授权、外部冲突、损坏文件与诊断')
    return
  }
  if (process.env.PI_DESKTOP_SIDEBAR_MENU_SMOKE_ONLY === '1') {
    await require('./sidebar-menu-smoke.cjs')(window, waitFor, directory, path.join(root, 'out', 'desktop-smoke'))
    await require('./multi-service-smoke.cjs')(window.webContents.getURL(), waitFor)
    console.log('侧栏菜单验收通过')
    return
  }
  if (process.env.PI_DESKTOP_PROFILE_SMOKE_ONLY === '1') {
    await click('button[aria-label="设置"]')
    await require('./profile-smoke.cjs')(window, waitFor, directory, path.join(root, 'out', 'desktop-smoke'))
    console.log('用量桌面验收通过：统计、活动图、主题、窄窗口、空状态与错误重试')
    return
  }
  if (process.env.PI_DESKTOP_MODEL_PICKER_SMOKE_ONLY === '1') {
    await fs.mkdir(path.join(root, 'out', 'desktop-smoke'), { recursive: true })
    await require('./model-picker-smoke.cjs')(window, waitFor, path.join(root, 'out', 'desktop-smoke'))
    console.log('模型选择桌面验收通过：长列表滚动、末项选择、搜索、空状态和小窗口')
    return
  }
  if (process.env.PI_DESKTOP_MODEL_SMOKE_ONLY === '1') {
    await fs.mkdir(path.join(root, 'out', 'desktop-smoke'), { recursive: true })
    await require('./model-config-smoke.cjs')(window, waitFor, path.join(root, 'out', 'desktop-smoke'))
    console.log('模型配置桌面验收通过：空配置首次添加与选择、失效模型恢复、服务商增删改、模型发现和凭据隐藏')
    return
  }
  await require('./mcp-smoke.cjs')(window, waitFor, path.join(root, 'out', 'desktop-smoke'))
  const model = 'button[aria-label="选择模型与思考强度"]'
  await waitFor(
    () =>
      evaluate(
        `Boolean(window.piMemeClient && document.querySelector(${JSON.stringify(model)}) && !document.querySelector(${JSON.stringify(model)}).disabled)`,
      ),
    '模型加载',
  )
  await evaluate(`window.piMemeClient.chooseDirectory(${JSON.stringify(gitDirectory)})`)
  await waitFor(
    () =>
      evaluate(
        `window.piMemeClient.getConnection().then(connection => connection.status === 'idle' && connection.cwd === ${JSON.stringify(gitDirectory)})`,
      ),
    '项目目录切换',
  )
  await require('./file-completion-smoke.cjs')(window, waitFor, setDraft, capture)
  await evaluate(`document.querySelector('button[aria-label="展开右侧栏"]')?.click()`)
  await waitFor(
    () =>
      evaluate(`Boolean(document.querySelector('#workspace-right-sidebar [role="tabpanel"][aria-label="新标签页"]'))`),
    '默认右侧工具选择页',
  )
  await openTool(window, waitFor, '变更')
  assert.equal(
    await evaluate(
      `document.querySelector('[role="tablist"][aria-label="右侧栏标签"] [role="tab"][aria-selected="true"]').textContent.trim()`,
    ),
    '变更',
    '从工具选择页打开 Git',
  )
  // 拖拽右句柄：宽度随拖动变化并受最小宽度约束
  const expectedRightWidth = await evaluate(`(() => {
    const handle = document.querySelector('[aria-label="调整右侧栏宽度"]')
    const width = () => Math.round(document.querySelector('#workspace-right-sidebar').getBoundingClientRect().width)
    const before = width()
    const workspaceWidth = handle.parentElement.getBoundingClientRect().width - document.querySelector('#workspace-sidebar').getBoundingClientRect().width
    const maxWidth = workspaceWidth - Math.min(320, workspaceWidth * 0.45)
    handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 800, pointerId: 1 }))
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 740, pointerId: 1 }))
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 740, pointerId: 1 }))
    return Math.round(Math.min(before + 60, maxWidth))
  })()`)
  await waitFor(
    () =>
      evaluate(
        `Math.round(document.querySelector('#workspace-right-sidebar').getBoundingClientRect().width) === ${expectedRightWidth}`,
      ),
    '右句柄拖拽调宽',
  )
  await evaluate(`(() => {
    const handle = document.querySelector('[aria-label="调整右侧栏宽度"]')
    handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 800, pointerId: 1 }))
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 4000, pointerId: 1 }))
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 4000, pointerId: 1 }))
  })()`)
  await waitFor(
    () =>
      evaluate(`Math.round(document.querySelector('#workspace-right-sidebar').getBoundingClientRect().width) === 280`),
    '右句柄最小宽度',
  )
  // 拖拽左句柄
  const leftBefore = await evaluate(`(() => {
    const handle = document.querySelector('[aria-label="调整侧边栏宽度"]')
    const width = () => Math.round(document.querySelector('#workspace-sidebar').getBoundingClientRect().width)
    const before = width()
    handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 200, pointerId: 1 }))
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 260, pointerId: 1 }))
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 260, pointerId: 1 }))
    return before
  })()`)
  await waitFor(
    () =>
      evaluate(
        `Math.round(document.querySelector('#workspace-sidebar').getBoundingClientRect().width) === ${leftBefore + 60}`,
      ),
    '左句柄拖拽调宽',
  )
  // 拖回原宽度，避免影响后续断言
  await evaluate(`(() => {
    const handle = document.querySelector('[aria-label="调整侧边栏宽度"]')
    handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 260, pointerId: 1 }))
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 200, pointerId: 1 }))
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 200, pointerId: 1 }))
  })()`)
  await waitFor(
    () =>
      evaluate(
        `Math.round(document.querySelector('#workspace-sidebar').getBoundingClientRect().width) === ${leftBefore}`,
      ),
    '左句柄恢复宽度',
  )
  await click('button[aria-label="收起右侧栏"]')
  await waitFor(() => evaluate(`!document.querySelector('#workspace-right-sidebar')`), '右侧栏关闭')
  await click('button[aria-label="展开右侧栏"]')
  await waitFor(() => evaluate(`Boolean(document.querySelector('#workspace-right-sidebar'))`), '右侧栏开关')
  assert.equal(
    await evaluate(
      `document.querySelector('[role="tablist"][aria-label="右侧栏标签"] [role="tab"][aria-selected="true"]').textContent`,
    ),
    'Git',
    '重开保持上次标签',
  )
  assert.equal(
    await evaluate(
      `Boolean(document.querySelector('header [aria-label="查看 Session Tree"], header [aria-label="查看 Git 变更"]'))`,
    ),
    false,
    '顶栏只保留打开应用和右侧栏开关',
  )
  assert.deepEqual(
    await evaluate(
      `[...document.querySelectorAll('[role="tablist"][aria-label="右侧栏标签"] [role="tab"]')].map(node => node.textContent.trim()).filter(title=>title!=='新标签页')`,
    ),
    ['Git'],
    '新会话仅显式打开 Git 工具标签',
  )
  await click('button[aria-label="收起右侧栏"]')
  await waitFor(() => evaluate(`!document.querySelector('#workspace-right-sidebar')`), '右侧栏关闭')

  const originalSize = window.getSize()
  for (const width of [720, 860, 1100]) {
    window.setSize(width, 650)
    await waitFor(() => evaluate(`window.innerWidth === ${width}`), '窄窗口尺寸')
    await click('button[aria-label="展开右侧栏"]')
    await waitFor(() => evaluate(`Boolean(document.querySelector('#workspace-right-sidebar'))`), '右侧栏并排显示')
    assert.equal(
      await evaluate(`(() => {
        const workspace = document.querySelector('[aria-label="工作区"]')
        const sidebar = document.querySelector('#workspace-sidebar')
        const panel = document.querySelector('#workspace-right-sidebar').getBoundingClientRect()
        return !sidebar.inert && sidebar.getBoundingClientRect().width > 0 && workspace.closest('[inert]') === null && panel.width < window.innerWidth
      })()`),
      true,
      `${width}px 右侧栏与主舞台并排，不接管全屏`,
    )
    await evaluate(`document.querySelector('#workspace-right-sidebar button')?.focus()`)
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ESCAPE' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ESCAPE' })
    await waitFor(() => evaluate(`!document.querySelector('#workspace-right-sidebar')`), 'Escape 收起右侧栏')
  }
  window.setSize(...originalSize)

  await click('button[aria-label="选择打开项目的应用"]')
  await waitFor(() => evaluate('document.body.textContent.includes("打开项目")'), '项目应用菜单')
  assert.equal(
    await evaluate('window.piMemeClient.getProjectApps().then(apps => apps.some(app => app.id === "finder"))'),
    true,
  )
  await evaluate(
    'document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))',
  )

  assert.equal(await evaluate('window.piMemeClient.getSnapshot().then(snapshot => snapshot.models.length)'), 2)
  await fs.mkdir(path.join(root, 'out', 'desktop-smoke'), { recursive: true })
  await capture('dark')
  await require('./model-config-smoke.cjs')(window, waitFor, path.join(root, 'out', 'desktop-smoke'))
  await click(model)
  await waitFor(() => evaluate('Boolean(document.querySelector("[role=slider]"))'), '思考强度面板')
  await evaluate(
    '(() => { const button = [...document.querySelectorAll("[role=dialog] button")].find(node => !node.getAttribute("aria-label")); if (!button) throw new Error("未找到模型列表入口"); button.click() })()',
  )
  await waitFor(() => evaluate('Boolean(document.querySelector("[aria-label=可用模型]"))'), '模型列表')
  await evaluate(
    '(() => { const button = [...document.querySelectorAll("[aria-label=可用模型] button")].find(node => node.textContent.includes("second")); button.click(); })()',
  )
  await waitFor(
    () => evaluate('window.piMemeClient.getSnapshot().then(snapshot => snapshot.state.model.id === "second")'),
    '模型切换',
  )
  await click(model)

  await click('button[aria-label="收起侧边栏"]')
  assert.equal(
    await evaluate(
      '(() => { const sidebar = document.querySelector("#workspace-sidebar"); return !sidebar || sidebar.getAttribute("aria-hidden") === "true" })()',
    ),
    true,
  )
  await waitFor(
    () => evaluate('(document.querySelector("#workspace-sidebar")?.getBoundingClientRect().width ?? 0) === 0'),
    '侧栏收起后不占宽度',
  )
  await click('button[aria-label="展开侧边栏"]')
  await waitFor(
    () => evaluate('document.querySelector("#workspace-sidebar").getBoundingClientRect().width === 256'),
    '侧栏展开动画',
  )
  await setDraft('设置页面保留草稿')
  await click('button[aria-label="设置"]')
  await waitFor(() => evaluate('Boolean(document.querySelector("section[aria-label=设置页面]"))'), '设置页面')
  assert.equal(await evaluate('Boolean(document.querySelector("[role=dialog]"))'), false)
  assert.equal(await evaluate('document.querySelector("#workspace-sidebar").checkVisibility()'), false)
  assert.equal(await evaluate('Boolean(document.querySelector("#pi-cli-path"))'), false)
  const distribution = JSON.parse(
    await fs.readFile(
      path.join(root, '..', '..', 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'),
      'utf8',
    ),
  )
  assert.equal(
    await evaluate('window.piMemeClient.getConnection().then(connection => connection.piVersion)'),
    distribution.version,
  )
  await clickText('关于')
  await capture('settings-about')
  await clickText('技能', 'nav[aria-label="设置分类"]')
  await waitFor(() => evaluate(`Boolean(document.querySelector('ul[aria-label="技能列表"]'))`), '技能列表')
  assert.equal(
    await evaluate(`document.querySelector('section[aria-label="技能管理"] [aria-label="资源类型"]') === null`),
    true,
  )
  assert.equal(
    await evaluate(`document.querySelector('section[aria-label="技能管理"]').textContent.includes("安装插件包")`),
    false,
  )
  const skillEntries = await evaluate(
    `[...document.querySelectorAll('ul[aria-label="技能列表"] li')].map(node => node.textContent).join("\\n")`,
  )
  // 校验 Desktop 应用数据目录中的两个验收技能都在列表中。
  assert.equal(skillEntries.includes('TypeScript 技能') && skillEntries.includes('review-code'), true)
  assert.equal(
    await evaluate(`document.querySelector('ul[aria-label="技能列表"]').textContent.includes("TypeScript 技能")`),
    true,
  )
  assert.equal(
    await evaluate(
      `document.querySelector('ul[aria-label="技能列表"]').textContent.includes("/skills/typescript/SKILL.md")`,
    ),
    false,
  )
  await click('button[aria-label="查看技能：typescript"]')
  await waitFor(() => evaluate(`Boolean(document.querySelector('section[aria-label="技能管理"]'))`), '技能详情')
  assert.equal(
    await evaluate(
      `document.querySelector('section[aria-label="技能管理"]').textContent.includes("/skills/typescript/SKILL.md")`,
    ),
    true,
  )
  await clickText('返回技能')
  assert.equal(
    await evaluate(`document.querySelector('ul[aria-label="技能列表"]').textContent.includes("review-code")`),
    true,
  )
  await capture('settings-skills')
  await require('./personalization-smoke.cjs')(window, waitFor, directory, path.join(root, 'out', 'desktop-smoke'))
  await require('./profile-smoke.cjs')(window, waitFor, directory, path.join(root, 'out', 'desktop-smoke'))
  await clickText('外观', 'nav[aria-label="设置分类"]')
  await require('./appearance-smoke.cjs')(window, waitFor, directory, path.join(root, 'out', 'desktop-smoke'))
  await click('button[aria-label="浅色模式"]')
  await choose('[role="combobox"][aria-label="外观主题"]', '浅色')
  await waitFor(
    () =>
      evaluate(
        'getComputedStyle(document.documentElement).getPropertyValue("--color-background").trim() === "#faf9fc"',
      ),
    '主题切换',
  )
  await waitFor(
    async () => JSON.parse(await fs.readFile(path.join(directory, 'settings.json'), 'utf8')).themeId === 'light',
    '浅色模式已保存',
  )
  await capture('light')
  await clickText('返回聊天')
  await waitFor(() => evaluate('!document.querySelector("section[aria-label=设置页面]")'), '返回聊天')
  assert.equal(
    await evaluate('document.querySelector("[contenteditable=true][aria-label=消息]").textContent'),
    '设置页面保留草稿',
  )
  assert.equal(await evaluate('document.querySelector("#workspace-sidebar").checkVisibility()'), true)

  await setDraft('输入法验收')
  const before = await evaluate('window.piMemeClient.getSnapshot().then(snapshot => snapshot.messages.length)')
  await evaluate(
    'document.querySelector("[contenteditable=true][aria-label=消息]").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }))',
  )
  assert.equal(await evaluate('window.piMemeClient.getSnapshot().then(snapshot => snapshot.messages.length)'), before)
  assert.equal(
    await evaluate(
      'document.querySelector("[contenteditable=true][aria-label=消息]").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, cancelable: true, bubbles: true }))',
    ),
    false,
  )
  await setDraft('')
  await require('./image-viewer-smoke.cjs')(window, waitFor, path.join(root, 'out', 'desktop-smoke'))
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAdElEQVR4Ae3AA6AkWZbG8f937o3IzKdyS2Oubdu2bdu2bdu2bWmMnpZKr54yMyLu+Xa3anqmhztr1a/+8R//8R/zb0fl34fKvw+Vfx8q/z5U/n2o/PtQ+feh8u9D5d+Hyr8PlX8fKv8+VP59qPz7UPn34R8BOSMDYXRfRXcAAAAASUVORK5CYII='
  const imageTransfer = `const file = new File([Uint8Array.from(atob(${JSON.stringify(png)}), char => char.charCodeAt(0))], 'test.png', { type: 'image/png' }); const transfer = new DataTransfer(); transfer.items.add(file);`
  await evaluate(
    `(() => { ${imageTransfer} document.querySelector('[contenteditable=true][aria-label=消息]').dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true })); })()`,
  )
  await waitFor(() => evaluate('Boolean(document.querySelector("[aria-label=已附加图片] img"))'), '粘贴图片')
  await assertImageLoaded('[aria-label=已附加图片] img', '粘贴图片缩略图')
  await click('button[aria-label="移除图片"]')
  await waitFor(() => evaluate('!document.querySelector("[aria-label=已附加图片] img")'), '移除图片')
  await evaluate(
    `(() => { ${imageTransfer} document.querySelector('form[aria-label="消息输入"]').dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true })); })()`,
  )
  await waitFor(() => evaluate('Boolean(document.querySelector("[aria-label=已附加图片] img"))'), '拖入图片')
  await assertImageLoaded('[aria-label=已附加图片] img', '拖入图片缩略图')
  await setDraft('桌面验收')
  await waitFor(() => evaluate('!document.querySelector("button[aria-label=发送消息]").disabled'), '发送按钮启用')
  const editingKey = await evaluate('window.piMemeClient.getConnection().then(connection => connection.sessionKey)')
  await evaluate(`(async () => {
    const session = await window.piMemeClient.resolveAppSession(${JSON.stringify(editingKey)});
    await window.smokeControl('sessions.configure',[{hostId:session.hostId,sessionId:session.sessionId},{agentPlugins:[${JSON.stringify(smokePluginId)}],accessMode:'full-access'}],true);
  })()`)
  await click('button[aria-label="发送消息"]')
  await waitTitle('确认继续执行')
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(model)}).disabled`), true)
  assert.equal(
    await evaluate('document.querySelector("[contenteditable=true][aria-label=消息]").isContentEditable'),
    true,
  )
  assert.equal(
    await evaluate('document.querySelector("[aria-label=扩展通知]")?.textContent.includes("App 插件通知")'),
    true,
  )
  assert.equal(await evaluate('document.querySelector("[aria-label=扩展状态]").textContent.includes("准备完成")'), true)
  const imagePart = 'snapshot.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])'
  assert.equal(
    await evaluate(
      `window.piMemeClient.getSnapshot().then(snapshot => ${imagePart}.some(part => part.type === "image"))`,
    ),
    true,
  )
  assert.deepEqual(
    await evaluate(
      `window.piMemeClient.getSnapshot().then(snapshot => ${imagePart}.find(part => part.type === "image"))`,
    ),
    { type: 'image', data: png, mimeType: 'image/png' },
  )

  const answerOption = (text) =>
    evaluate(
      `(() => {const option = [...document.querySelector(${JSON.stringify(dialog)}).querySelectorAll('[role=radio]')].find(node => node.textContent.includes(${JSON.stringify(text)})); if (!option) throw new Error('找不到回答选项'); option.click()})()`,
    )
  const answerText = (text) =>
    evaluate(
      `(() => {const input = document.querySelector(${JSON.stringify(dialog)}).querySelector('textarea[aria-label="自行撰写回复"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(text)});input.dispatchEvent(new Event('input',{bubbles:true}))})()`,
    )
  await answerOption('确认')
  await clickText('下一步', dialog)
  await waitTitle('选择环境')
  await answerOption('生产')
  await clickText('下一步', dialog)
  await waitTitle('可取消输入')
  await clickText('跳过', dialog)
  await waitTitle('输入名称')
  await answerText('Pi 桌面端')
  await clickText('下一步', dialog)
  await waitTitle('编辑内容')
  await answerText('App 编辑结果')
  await clickText('发送', dialog)
  await waitFor(() => evaluate(`!document.querySelector(${JSON.stringify(dialog)})`), 'App 提问回答完成')
  await waitFor(
    () =>
      evaluate(
        'window.piMemeClient.getSnapshot().then(snapshot => snapshot.messages.some(message => message.role === "assistant" && message.content.some(part => part.type === "text" && part.text.includes("App 编辑结果"))))',
      ),
    'App 回答回传模型',
  )
  const appResult = await evaluate(
    'window.piMemeClient.getSnapshot().then(snapshot => snapshot.messages.find(message => message.role === "custom" && message.customType === "smoke-dialog-result"))',
  )
  assert.equal(appResult.source.ownerId, smokePluginId)
  assert.equal(typeof appResult.source.generation, 'number')

  await assertImageLoaded('img[alt=用户附件图片]', '消息图片缩略图')
  await evaluate('document.querySelector("img[alt=用户附件图片]").closest("button").click()')
  const attachmentPreview = 'img[alt="图片大图预览，第 1 张"]'
  await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(attachmentPreview)}))`), '附件预览')
  await assertImageLoaded(attachmentPreview, '附件大图预览')
  await clickText('Close', '[role="dialog"]')
  await waitFor(() => evaluate('!document.querySelector("[role=dialog]")'), '预览关闭')

  const work = '[aria-label="工作过程"]'
  // 同一会话可能有多个工作过程分组，取最后一个（当前轮）。
  const lastWork = `[...document.querySelectorAll(${JSON.stringify(work)})].at(-1)`
  const readLastWork = () =>
    evaluate(`(() => { const node = ${lastWork}; return node ? node.textContent.trim() : "" })()`)
  await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(work)}))`), '工作过程')
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(work)}).getAttribute('aria-expanded')`), 'false')
  assert.match(
    await evaluate(`document.querySelector(${JSON.stringify(work)}).textContent.trim()`),
    /^用时(?: \d+秒|不足1秒)$/,
  )
  await click(work)
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(work)}).getAttribute('aria-expanded')`), 'true')
  assert.equal(
    await evaluate(
      'Array.from(document.querySelectorAll("[aria-label^=工具详情]"), node => node.getAttribute("aria-expanded")).every(value => value === "false")',
    ),
    true,
  )
  assert.equal(await evaluate('document.body.textContent.includes("展开所有")'), false)
  assert.equal(
    await evaluate('getComputedStyle(document.querySelector("[aria-label=工作过程详情]")).maxHeight'),
    'none',
  )
  assert.equal(
    await evaluate('getComputedStyle(document.querySelector("[aria-label=工作过程详情]")).overflowY'),
    'visible',
  )
  await click(work)

  await setDraft('/')
  await waitFor(
    () => evaluate('document.querySelectorAll("#composer-suggestions [role=option]").length > 8'),
    '完整命令列表',
  )
  assert.equal(await evaluate('document.querySelector("#composer-suggestions").textContent.includes("/compact")'), true)
  assert.equal(
    await evaluate(
      'document.querySelector("#composer-suggestions").scrollHeight > document.querySelector("#composer-suggestions").clientHeight',
    ),
    true,
  )
  await evaluate('document.querySelector("#composer-suggestions").scrollTop = 10000')
  assert.equal(await evaluate('document.querySelector("#composer-suggestions").scrollTop > 0'), true)
  await setDraft('/re')
  await waitFor(() => evaluate('Boolean(document.querySelector("[role=listbox][aria-label=斜杠命令]"))'), '命令建议')
  await evaluate(
    'document.querySelector("[contenteditable=true][aria-label=消息]").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))',
  )
  await evaluate(
    'document.querySelector("[contenteditable=true][aria-label=消息]").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))',
  )
  assert.equal(
    await evaluate('document.querySelector("[contenteditable=true][aria-label=消息]").textContent'),
    '/review ',
  )
  await require('./composer-layout-smoke.cjs')(window, capture)
  await setDraft('待处理验收')
  await waitFor(() => evaluate('!document.querySelector("button[aria-label=发送消息]").disabled'), '发送队列验收任务')
  const workCount = 'document.querySelectorAll("[aria-label=工作过程]").length'
  const workCountBefore = await evaluate(workCount)
  await click('button[aria-label="发送消息"]')
  await waitFor(() => evaluate(`${workCount} > ${workCountBefore}`), '队列验收工作过程')
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(model)}).disabled`), true)
  const firstElapsed = await readLastWork()
  await waitFor(async () => (await readLastWork()) !== firstElapsed, '运行计时更新')
  await setDraft('排队验收')
  await click('button[aria-label="发送排队任务"]')
  await waitFor(
    () => evaluate('document.querySelector("[aria-label=待处理任务队列]")?.textContent.includes("排队验收")'),
    '默认后续排队',
  )
  await setDraft('保留草稿')
  await evaluate(
    'document.querySelector("[contenteditable=true][aria-label=消息]").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))',
  )
  assert.equal(
    await evaluate('document.querySelector("[aria-label=待处理任务队列]")?.textContent.includes("排队验收")'),
    true,
    'Escape保留队列',
  )
  assert.equal(
    await evaluate('document.querySelector("[contenteditable=true][aria-label=消息]").textContent'),
    '保留草稿',
  )
  assert.equal(await evaluate('Boolean(document.querySelector("button[aria-label=运行模式]"))'), false)
  await click('button[aria-label="删除排队消息"]')
  await waitFor(() => evaluate('!document.querySelector("[aria-label=待处理任务队列]")'), '逐条删除队列')
  await setDraft('后续验收')
  await click('button[aria-label="发送排队任务"]')
  await waitFor(
    () => evaluate('document.querySelector("[aria-label=待处理任务队列]")?.textContent.includes("后续验收")'),
    '后续队列',
  )
  await capture('tool')
  await setDraft('')
  await click('button[aria-label="暂停当前任务"]')
  await waitFor(() => evaluate('Boolean(document.querySelector("button[aria-label=继续当前任务]"))'), '暂停运行')
  await evaluate(
    'window.piMemeClient.getConnection().then(connection => window.piMemeClient.abort(connection.sessionKey))',
  )
  await waitFor(
    () => evaluate('window.piMemeClient.getSnapshot().then(snapshot => !snapshot.state.isStreaming)'),
    '清理队列验收任务',
  )
  await clickText('新聊天', 'aside[aria-label="侧边栏"]')
  await waitFor(() => evaluate('document.querySelector("h1")?.textContent === "开始一个新任务"'), '新会话')

  await setDraft('stream')
  await waitFor(
    () => evaluate('document.querySelector("button[aria-label=发送消息]").disabled === false'),
    '新会话运行时就绪',
  )
  await click('button[aria-label="发送消息"]')
  await waitFor(() => evaluate(`Boolean(${lastWork})`), '流式工作过程')
  // 运行时自动展开，工具执行很快时也可能已收尾并自动收起。
  assert.match(await readLastWork(), /^(?:处理中|用时(?: \d+秒|不足1秒))/)
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(model)}).disabled`), true)
  await waitFor(
    () =>
      evaluate('Boolean(document.querySelector("[aria-label=对话消息流]")?.textContent.includes("流式正文已生成"))'),
    '正式流式正文',
  )
  await waitFor(() => evaluate(`!document.querySelector(${JSON.stringify(model)}).disabled`), '流式结束')
  assert.equal(await evaluate(`${lastWork}.getAttribute('aria-expanded')`), 'false')
  assert.equal((await readLastWork()).includes('读取了 1 个文件'), false)
  assert.equal((await readLastWork()).includes('思考过程'), false)
  await evaluate(`${lastWork}.click()`)
  await waitFor(
    () => evaluate(`Boolean(${lastWork}) && ${lastWork}.getAttribute('aria-expanded') === 'true'`),
    '展开工作过程',
  )
  await waitFor(() => evaluate('Boolean(document.querySelector("[aria-label=思考过程]"))'), '思考行')
  assert.notEqual(await evaluate('document.querySelector("[aria-label=思考过程]").textContent.trim()'), '')
  if (await evaluate('document.querySelector("[aria-label=思考过程]").getAttribute("aria-expanded") === "false"'))
    await click('[aria-label="思考过程"]')
  await waitFor(
    () => evaluate('Boolean(document.querySelector("[aria-label=对话消息流]")?.textContent.includes("检查项目文件"))'),
    '思考详情',
  )
  const readTool = '[role="button"][aria-label="工具详情：read"]'
  await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(readTool)}))`), '工具详情行')
  const toolWasOpen = await evaluate(
    `document.querySelector(${JSON.stringify(readTool)}).getAttribute('aria-expanded')`,
  )
  await click(readTool)
  assert.notEqual(
    await evaluate(`document.querySelector(${JSON.stringify(readTool)}).getAttribute('aria-expanded')`),
    toolWasOpen,
  )
  await click(readTool)
  await capture('stream')

  await setDraft('long-conversation')
  await click('button[aria-label="发送消息"]')
  await waitFor(
    () => evaluate('document.querySelector("[aria-label=对话消息流]")?.textContent.includes("第 80 段")'),
    '长对话',
  )
  await waitFor(() => evaluate(`!document.querySelector(${JSON.stringify(model)}).disabled`), '长对话结束')
  const scrollGeometry = await evaluate(`(() => {
    const container = document.querySelector('[aria-label="对话消息流"]');
    const parents = []; let node = container;
    while (node && parents.length < 6) {
      parents.push({tag:node.tagName,id:node.id,label:node.getAttribute('aria-label'),height:node.getBoundingClientRect().height,minHeight:getComputedStyle(node).minHeight});
      node = node.parentElement;
    }
    return {scrollHeight:container.scrollHeight,clientHeight:container.clientHeight,viewportHeight:window.innerHeight,parents};
  })()`)
  assert.ok(
    scrollGeometry.scrollHeight > scrollGeometry.clientHeight,
    `长对话在消息容器内滚动：${JSON.stringify(scrollGeometry)}`,
  )
  await evaluate(
    '(() => { const container = document.querySelector("[aria-label=对话消息流]"); container.scrollTo({ top: 0, behavior: "instant" }); container.dispatchEvent(new Event("scroll")); })()',
  )
  await waitFor(() => evaluate('Boolean(document.querySelector("button[aria-label=滚动到底部]"))'), '回到底部按钮')
  await click('button[aria-label="滚动到底部"]')
  await waitFor(() => evaluate('!document.querySelector("button[aria-label=滚动到底部]")'), '回到底部')
  console.log('桌面验收阶段通过：模型、MCP、设置、右侧标签、App 交互、流式消息与长对话滚动')
  await require('./collaboration-plan-smoke.cjs')(window, waitFor, directory, path.join(root, 'out', 'desktop-smoke'))
  console.log('桌面验收阶段通过：子代理协作与计划')
  await require('./extensions-smoke.cjs')(window, waitFor, directory, path.join(root, 'out', 'desktop-smoke'))
  await require('./agent-access-smoke.cjs')(window, waitFor, directory)
  console.log('桌面验收阶段通过：App 插件与会话权限')
  await require('./lazy-sessions-smoke.cjs')(window, waitFor, directory, gitDirectory)
  await require('./project-selector-smoke.cjs')(
    window,
    waitFor,
    directory,
    path.join(root, 'out', 'desktop-smoke'),
    gitDirectory,
  )
  await require('./sidebar-menu-smoke.cjs')(
    window,
    waitFor,
    directory,
    path.join(root, 'out', 'desktop-smoke'),
    gitDirectory,
  )
  await require('./background-sessions-smoke.cjs')(window, waitFor, gitDirectory)
  await require('./session-switch-smoke.cjs')(window.webContents.getURL(), waitFor)
  await require('./multi-service-smoke.cjs')(window.webContents.getURL(), waitFor)
  console.log(
    '桌面验收通过：Radix 模型与主题、侧栏、输入法、图片、App 插件多题交互、工作过程折叠、命令补全、队列、停止、新建会话、正式流式消息与滚动',
  )
}

;(async () => {
  gitDirectory = fsSync.realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'pi-desktop-smoke-project-')))
  await fs.mkdir(path.join(gitDirectory, 'src'), { recursive: true })
  await fs.mkdir(path.join(gitDirectory, 'reference-fixture'))
  await fs.writeFile(path.join(gitDirectory, 'README.md'), '# 验收项目\n')
  await fs.writeFile(path.join(gitDirectory, 'src', 'main.ts'), 'export const main = true\n')
  await fs.writeFile(path.join(gitDirectory, 'reference-fixture', '中文 文件.ts'), 'export const value = 1\n')
  await fs.writeFile(path.join(gitDirectory, 'reference-fixture', 'nested-file.ts'), 'export const nested = true\n')
  execFileSync('git', ['init', '--quiet', gitDirectory])
  await fs.mkdir(path.join(root, 'out', 'desktop-smoke'), { recursive: true })
  const { startSmokeAgent } = await import('./smoke-agent.mjs')
  smokeAgent = await startSmokeAgent(directory, {
    queueReview: process.env.PI_DESKTOP_QUEUE_REVIEW === '1',
    queueSmoke: process.env.PI_DESKTOP_QUEUE_SMOKE_ONLY === '1',
    pauseSmoke: process.env.PI_DESKTOP_PAUSE_SMOKE_ONLY === '1' || process.env.PI_DESKTOP_PAUSE_REVIEW === '1',
    picker: process.env.PI_DESKTOP_MODEL_PICKER_SMOKE_ONLY === '1',
    emptyModels: process.env.PI_DESKTOP_MODEL_SMOKE_ONLY === '1',
  })
  await app.whenReady()
  const modelCredentials = {
    ...(process.env.PI_DESKTOP_MODEL_SMOKE_ONLY === '1'
      ? {}
      : { 'model-provider:fake': JSON.stringify({ credential: { type: 'api_key', key: 'test' } }) }),
    ...(process.env.PI_DESKTOP_MODEL_PICKER_SMOKE_ONLY === '1'
      ? { 'model-provider:picker-test': JSON.stringify({ credential: { type: 'api_key', key: 'test' } }) }
      : {}),
  }
  await fs.mkdir(path.join(directory, 'secure'), { recursive: true })
  await fs.writeFile(path.join(directory, 'auth.json'), JSON.stringify(modelCredentials), { mode: 0o600 })
  const appDirectory = path.join(directory, 'smoke-app')
  await fs.mkdir(appDirectory, { recursive: true })
  await fs.writeFile(
    path.join(appDirectory, 'package.json'),
    JSON.stringify({
      name: smokePluginId,
      version: '1.0.0',
      type: 'module',
      piMeme: { sdkVersion: 2, agent: 'dist/agent.js' },
    }),
  )
  await require('esbuild').build({
    entryPoints: [path.join(root, '..', '..', 'tests', 'fixtures', 'smoke-app-agent.mjs')],
    outfile: path.join(appDirectory, 'dist', 'agent.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
  })
  await fs.writeFile(
    path.join(directory, 'settings.json'),
    JSON.stringify({ themeId: 'dark', defaultAccessMode: 'workspace-write', mcpEnabled: false }),
  )
  app.once('browser-window-created', (_event, window) => {
    window.webContents.setBackgroundThrottling(false)
    window.webContents.once('did-finish-load', () => {
      // 复制路径等操作依赖文档获得焦点，验收时主动把窗口拉到前台。
      if (process.platform === 'darwin') app.focus({ steal: true })
      window.show()
      window.focus()
      window.webContents.focus()
      if (process.env.PI_DESKTOP_QUEUE_REVIEW === '1' || process.env.PI_DESKTOP_PAUSE_REVIEW === '1') {
        let screenshotNumber = 0
        window.webContents.on('before-input-event', (event, input) => {
          if (input.type !== 'keyDown' || !input.meta || !input.shift) return
          if (input.code === 'KeyF' && process.env.PI_DESKTOP_PAUSE_REVIEW === '1') {
            event.preventDefault()
            smokeAgent.releaseQueueReply()
          }
          if (input.code === 'KeyS') {
            event.preventDefault()
            const screenshot = path.join(
              root,
              'out',
              'desktop-smoke',
              `${process.env.PI_DESKTOP_PAUSE_REVIEW === '1' ? 'pause' : 'queue'}-review-${++screenshotNumber}.png`,
            )
            void window.webContents
              .capturePage()
              .then((image) => fs.writeFile(screenshot, image.toPNG()))
              .then(() => console.log(`人工验收截图：${screenshot}`))
              .catch(console.error)
          }
          const sizes = { Digit1: '620px', Digit2: '420px', Digit3: '320px', Digit0: '' }
          if (Object.hasOwn(sizes, input.code)) {
            event.preventDefault()
            void window.webContents
              .executeJavaScript(
                `document.querySelector('[data-testid="composer-area"]').style.width=${JSON.stringify(sizes[input.code])}`,
              )
              .catch(console.error)
          }
        })
        console.log(`人工验收窗口已启动，临时数据目录：${directory}`)
        return
      }
      const task = prepareSmokeApp(
        window,
        process.env.PI_DESKTOP_APP_PLUGIN_SMOKE_ONLY !== '1' && process.env.PI_DESKTOP_SIDEBAR_SMOKE_ONLY !== '1',
      ).then(() =>
        process.env.PI_DESKTOP_APP_PLUGIN_SMOKE_ONLY === '1'
          ? runAppPlugins(window)
          : process.env.PI_DESKTOP_SIDEBAR_SMOKE_ONLY === '1'
            ? require('./sidebar-menu-smoke.cjs')(
                window,
                waitFor,
                directory,
                path.join(root, 'out', 'desktop-smoke'),
                gitDirectory,
              )
            : process.env.PI_DESKTOP_ACCESS_SMOKE_ONLY === '1'
              ? (async () => {
                  const evaluate = (code) => window.webContents.executeJavaScript(code)
                  await evaluate(`window.piMemeClient.chooseDirectory(${JSON.stringify(gitDirectory)})`)
                  const key = await evaluate('window.piMemeClient.getConnection().then(value=>value.sessionKey)')
                  await evaluate(`window.piMemeClient.setModel(${JSON.stringify(key)},{provider:'fake',id:'first'})`)
                  await evaluate(`window.piMemeClient.prompt(${JSON.stringify(key)},'权限验收前置会话')`)
                  await waitFor(
                    () =>
                      evaluate(
                        'window.piMemeClient.getSnapshot().then(value=>Boolean(value.connection.sessionFile)&&!value.state.isStreaming)',
                      ),
                    '权限验收前置会话完成',
                  )
                  await require('./agent-access-smoke.cjs')(window, waitFor, directory)
                })()
              : process.env.PI_DESKTOP_SESSION_SMOKE_ONLY === '1'
                ? (async () => {
                    await require('./session-switch-smoke.cjs')(window.webContents.getURL(), waitFor)
                    console.log('会话专项通过：并发会话切换')
                    await require('./multi-service-smoke.cjs')(window.webContents.getURL(), waitFor)
                    console.log('会话专项通过：多服务设备隔离')
                    const evaluate = (code) => window.webContents.executeJavaScript(code)
                    const firstDirectory = path.join(gitDirectory, 'background-first')
                    await fs.mkdir(firstDirectory)
                    await evaluate(`window.piMemeClient.chooseDirectory(${JSON.stringify(firstDirectory)})`)
                    const key = await evaluate('window.piMemeClient.getConnection().then(value=>value.sessionKey)')
                    await evaluate(`window.piMemeClient.setModel(${JSON.stringify(key)},{provider:'fake',id:'first'})`)
                    await require('./background-sessions-smoke.cjs')(window, waitFor, gitDirectory)
                    console.log('会话专项通过：后台任务与路由')
                  })()
                : process.env.PI_DESKTOP_PAUSE_SMOKE_ONLY === '1'
                  ? require('./pause-display-smoke.cjs')(
                      window,
                      waitFor,
                      directory,
                      path.join(root, 'out', 'desktop-smoke'),
                      smokeAgent,
                    )
                  : process.env.PI_DESKTOP_QUEUE_SMOKE_ONLY === '1'
                    ? require('./queue-composer-smoke.cjs')(
                        window,
                        waitFor,
                        directory,
                        path.join(root, 'out', 'desktop-smoke'),
                        smokeAgent,
                      )
                    : run(window),
      )
      task
        .catch(async (error) => {
          failed = true
          console.error(error)
          if (process.env.PI_DESKTOP_SIDEBAR_SMOKE_ONLY === '1')
            console.error(
              '侧栏窗口焦点诊断',
              JSON.stringify({
                nativeFocus: window.isFocused(),
                webContentsFocus: window.webContents.isFocused(),
                blurCount: await window.webContents.executeJavaScript('window.sidebarWindowBlurCount'),
              }),
            )
          await fs.writeFile(
            path.join(root, 'out', 'desktop-smoke', 'failed.png'),
            (await window.webContents.capturePage()).toPNG(),
          )
          console.error(await window.webContents.executeJavaScript('document.body.innerText.slice(0, 3000)'))
        })
        .finally(() => {
          process.exitCode = failed ? 1 : 0
          app.quit()
        })
    })
  })
  app.on('will-quit', (event) => {
    event.preventDefault()
    smokeAgent?.releaseQueueReply()
    void Promise.all([
      smokeAgent?.provider.close(),
      fs.rm(directory, { recursive: true, force: true }),
      fs.rm(gitDirectory, { recursive: true, force: true }),
    ]).finally(() => app.exit(failed ? 1 : 0))
  })
  const main =
    process.env.PI_DESKTOP_PACKAGED_SMOKE === '1'
      ? path.join(
          root,
          'out',
          'pi-meme-darwin-arm64',
          'pi-meme.app',
          'Contents',
          'Resources',
          'app.asar',
          '.vite',
          'build',
          'main.js',
        )
      : path.join(root, '.vite', 'build', 'main.js')
  require(main)
})().catch((error) => {
  console.error(error)
  app.exit(1)
})
