const fs = require('node:fs/promises')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const { within, desktopTestHelpers } = require('./desktop-test-helpers.cjs')

const argument = process.argv.find((value) => value.startsWith('--pi-test-config='))
if (!argument) throw new Error('桌面测试缺少隔离配置文件。')

;(async () => {
  const config = JSON.parse(await fs.readFile(argument.slice('--pi-test-config='.length), 'utf8'))
  const directory = config.directory
  const screenshots = config.screenshots
  const project = config.project
  const cache = path.join(directory, 'desktop-cache')
  app.setPath('userData', cache)
  app.commandLine.appendSwitch('user-data-dir', cache)
  const { startSmokeAgent } = await import('./smoke-agent.mjs')
  const agent = await startSmokeAgent(directory, config.agentOptions)
  const window = () => BrowserWindow.getAllWindows().find((value) => !value.isDestroyed())
  async function waitFor(check, label = '界面状态') {
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      if (await within(Promise.resolve().then(check), Math.max(1, deadline - Date.now()), label)) return
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error(`桌面测试等待超时：${label}`)
  }
  globalThis.piMemeDesktopTest = {
    async prepare() {
      const current = window()
      const execute = current.webContents.executeJavaScript.bind(current.webContents)
      current.webContents.executeJavaScript = (code, ...args) =>
        within(execute(code, ...args), 10000, `执行脚本：${code}`).catch((cause) => {
          throw new Error(`桌面验收脚本执行失败：${code}`, { cause })
        })
      const capture = current.webContents.capturePage.bind(current.webContents)
      current.webContents.capturePage = (...args) => within(capture(...args), 5000, '截取页面')
      current.webContents.setBackgroundThrottling(false)
      current.show()
      current.focus()
      current.webContents.focus()
      const evaluate = (code) => current.webContents.executeJavaScript(code)
      await waitFor(() => evaluate('Boolean(window.piMemeClient && window.piPlatform)'), 'Host 客户端初始化')
      await evaluate(`(async () => {
        const connection = await window.piPlatform.getHostConnection();
        window.smokeRpc = async (method,args=[],sessionId) => {
          const response = await fetch(new URL('/api/rpc',connection.url),{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:crypto.randomUUID(),clientId:'desktop-e2e',method,args,sessionId})});
          const value=await response.json(); if(!response.ok||value.error) throw new Error(value.error?.message||'Host 操作失败'); return value.result;
        };
        window.smokeControl = async (method,args=[],mutation=false) => {
          const response=await fetch(new URL('/api/control',connection.url),{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({apiVersion:2,clientId:'desktop-e2e',method,args,...(mutation?{idempotencyKey:crypto.randomUUID()}:{})})});
          const value=await response.json(); if(!response.ok||value.error) throw new Error(value.error?.message||'Host 控制操作失败'); return value.result;
        };
        await window.smokeRpc('plugins:install-directory',[${JSON.stringify(path.join(directory, 'smoke-app'))}]);
        await window.smokeControl('plugins.setDefaultAgentPlugins',[['@pi-meme-fixtures/desktop-smoke']],true);
        const state=await window.piMemeClient.getConnection();
        const session=await window.piMemeClient.resolveAppSession(state.sessionKey);
        await window.smokeControl('sessions.configure',[{hostId:session.hostId,sessionId:session.sessionId},{agentPlugins:['@pi-meme-fixtures/desktop-smoke']}],true);
        if (!${Boolean(config.agentOptions.emptyModels)}) await window.piMemeClient.setModel(state.sessionKey,{provider:'fake',id:'first'});
      })()`)
    },
    async run(name) {
      const current = window()
      const scenario = require(`./${name}-smoke.cjs`)
      const helpers = desktopTestHelpers(current, waitFor, screenshots)
      if (name === 'composer-layout') return scenario(current, helpers.capture)
      if (name === 'file-completion') {
        const setDraft = (value) =>
          helpers.evaluate(`(() => {
          const editor = document.querySelector('[contenteditable=true][aria-label="消息"]');
          editor.textContent = ${JSON.stringify(value)}; editor.focus();
          const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false);
          const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
          editor.dispatchEvent(new Event('input', {bubbles:true}));
        })()`)
        return scenario(current, waitFor, setDraft, helpers.capture)
      }
      if (['session-switch', 'multi-service'].includes(name))
        return scenario(current.webContents.getURL(), waitFor, screenshots)
      if (name === 'background-sessions') {
        const other = path.join(path.dirname(project), 'background-other')
        await fs.mkdir(other, { recursive: true })
        return scenario(current, waitFor, other, screenshots)
      }
      if (name === 'lazy-sessions') return scenario(current, waitFor, directory, project, screenshots)
      if (name === 'queue-composer') return scenario(current, waitFor, directory, screenshots, agent)
      if (name === 'pause-display') return scenario(current, waitFor, project, screenshots, agent)
      if (['mcp', 'model-config', 'model-picker', 'select-controls', 'image-viewer'].includes(name))
        return scenario(current, waitFor, screenshots)
      if (name === 'plan-composer') return scenario(current, waitFor, directory, screenshots, { cold: true })
      return scenario(current, waitFor, directory, screenshots, project)
    },
    async dispose() {
      agent.releaseQueueReply()
      await agent.provider.close()
    },
  }
  require(path.resolve(__dirname, '../../.vite/build/main.js'))
})().catch((cause) => {
  console.error(cause)
  app.exit(1)
})
