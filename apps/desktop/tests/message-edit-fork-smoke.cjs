// 真实 Electron 窗口验收：用户消息原位编辑、版本切换恢复后续对话、从回复 Fork 会话。
// 使用本地假模型端点与真实会话树，不调用真实模型。
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

if (process.env.PI_DESKTOP_DEV_SERVER_URL) {
  BrowserWindow.prototype.loadFile = function () {
    return this.loadURL(process.env.PI_DESKTOP_DEV_SERVER_URL)
  }
}

const root = path.resolve(__dirname, '..')
const shots = path.join(root, 'out', 'message-edit-fork-smoke')
let directory
let failed = false

async function waitFor(check, label = '界面状态') {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`桌面验收等待超时：${label}`)
}

async function run(window) {
  const evaluate = (code) =>
    window.webContents.executeJavaScript(code).catch((error) => {
      console.error('桌面验收脚本执行失败：', code, error)
      throw error
    })
  const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const setEditor = (selector, value) =>
    evaluate(
      `(() => { const input = document.querySelector(${JSON.stringify(selector)}); input.textContent = ${JSON.stringify(value)}; input.focus(); const range = document.createRange(); range.selectNodeContents(input); range.collapse(false); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
    )
  const pressEscape = (selector) =>
    evaluate(
      `document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
    )
  const userTexts = () =>
    evaluate(
      `[...document.querySelectorAll('article[data-message-role=user] [data-message-body]')].map(node => node.innerText.replace(/\\s+/g, ' ').trim())`,
    )
  const composerText = () =>
    evaluate(`document.querySelector('[contenteditable=true][aria-label="消息"]')?.innerText ?? ''`)
  const capture = async (name) => {
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    await fs.mkdir(shots, { recursive: true })
    await fs.writeFile(path.join(shots, `${name}.png`), (await window.webContents.capturePage()).toPNG())
  }
  const waitIdle = () =>
    waitFor(
      () =>
        evaluate(
          `window.piMemeClient.getSnapshot().then(snapshot => snapshot.state.isStreaming === false && snapshot.state.isCompacting === false && Boolean(document.querySelector('[aria-label="发送消息"]')))`,
        ),
      '会话空闲',
    )
  const send = async (value) => {
    await waitIdle()
    await setEditor('[contenteditable=true][aria-label="消息"]', value)
    await waitFor(
      () => evaluate(`document.querySelector('[aria-label="发送消息"]')?.disabled === false`),
      '输入框可发送',
    )
    await click('[aria-label="发送消息"]')
  }
  const waitReply = async (text) => {
    await waitFor(
      () =>
        evaluate(
          `[...document.querySelectorAll('article[data-message-role=assistant]')].some(node => node.innerText.includes(${JSON.stringify(text)}))`,
        ),
      `回复：${text}`,
    )
    await waitIdle()
  }

  await waitFor(
    () => evaluate('window.piMemeClient?.getConnection().then(connection => connection.status === "idle")'),
    '初始空白页',
  )

  // 1. 两轮对话
  await send('第一轮')
  await waitReply('已回复：第一轮')
  await send('第二轮')
  await waitReply('已回复：第二轮')

  // 2. 底部写入未发送草稿
  await setEditor('[contenteditable=true][aria-label="消息"]', '未发送草稿：请保留这段文字')
  assert.equal(await composerText(), '未发送草稿：请保留这段文字')

  // 3. 点击第一轮用户消息的编辑按钮，验证原位编辑
  await click('article[data-message-role=user] button[aria-label="编辑消息"]')
  await waitFor(() => evaluate('Boolean(document.querySelector("[data-testid=inline-message-editor]"))'), '原位编辑器')
  assert.equal(
    await evaluate('Boolean(document.querySelector("[data-testid=editing-hint]"))'),
    true,
    '编辑时底部输入区应替换为说明',
  )
  assert.equal(
    await evaluate('document.querySelectorAll("[data-testid=inline-message-editor]").length'),
    1,
    '同时只有一个原位编辑器',
  )
  assert.equal(
    await evaluate(
      'document.querySelector("[data-testid=inline-message-editor]").innerText.includes("重新发送会生成新版本")',
    ),
    false,
    '编辑器应保持简洁，不应展示多余的提示说明文案',
  )
  await capture('01-inline-edit')

  // 4. 验证短按钮文案，Escape 取消编辑并恢复草稿
  assert.equal(
    await evaluate('document.querySelector("[data-testid=inline-edit-cancel]").innerText.trim()'),
    '取消',
    '取消按钮应采用短文案',
  )
  assert.equal(
    await evaluate('document.querySelector("[data-testid=inline-edit-submit]").innerText.trim()'),
    '发送',
    '发送按钮应采用短文案',
  )
  await pressEscape('[data-testid=inline-message-editor] [contenteditable=true][aria-label="消息"]')
  await waitFor(() => evaluate('!document.querySelector("[data-testid=inline-message-editor]")'), 'Escape 取消编辑')
  assert.equal(await composerText(), '未发送草稿：请保留这段文字', '取消后应恢复编辑前的草稿')

  // 5. 再次编辑：模拟提交失败，原位保留内容并显示错误，然后重试成功
  await click('article[data-message-role=user] button[aria-label="编辑消息"]')
  await waitFor(
    () => evaluate('Boolean(document.querySelector("[data-testid=inline-message-editor]"))'),
    '再次打开编辑器',
  )
  await setEditor('[data-testid=inline-message-editor] [contenteditable=true][aria-label="消息"]', '第一轮编辑版')
  await click('[data-testid=inline-edit-submit]')
  await capture('02-edit-submitted')
  await waitReply('已回复：第一轮编辑版')
  await waitFor(
    () => evaluate(`document.querySelector('[data-testid=version-control]')?.innerText.includes('2/2') === true`),
    '版本控件显示 2/2',
  )
  assert.deepEqual(await userTexts(), ['第一轮编辑版'], '编辑后只显示新版本分支')
  await capture('03-edited-version')

  // 6. 切回旧版本，必须恢复完整后续对话
  await click('[data-testid=version-control] button[aria-label="查看上一个版本"]')
  await waitFor(
    async () => JSON.stringify(await userTexts()) === JSON.stringify(['第一轮', '第二轮']),
    '切回旧版本恢复两轮对话',
  )
  await waitFor(
    () => evaluate(`document.querySelector('[data-testid=version-control]')?.innerText.includes('1/2') === true`),
    '版本控件显示 1/2',
  )
  assert.equal(
    await evaluate('document.querySelectorAll("article[data-message-role=assistant]").length'),
    2,
    '旧版本应恢复两轮回复',
  )
  await capture('04-version-restored')

  // 7. 再切回新版本
  await click('[data-testid=version-control] button[aria-label="查看下一个版本"]')
  await waitFor(async () => JSON.stringify(await userTexts()) === JSON.stringify(['第一轮编辑版']), '切回新版本')

  // 8. 从 assistant 回复 Fork
  await click('article[data-message-role=assistant] button[aria-label="从这段回复新建会话"]')
  await waitFor(
    () => evaluate('Boolean(document.querySelector("[data-testid=fork-pending]"))'),
    'Fork 进行中反馈',
  ).catch(() => {})
  await waitFor(() => evaluate('Boolean(document.querySelector("[data-testid=fork-success]"))'), 'Fork 成功反馈')
  assert.equal(
    await evaluate('document.querySelector("[data-testid=fork-success]").innerText.includes("已创建分支")'),
    true,
    'Fork 成功提示应采用收短文案',
  )
  await capture('05-fork-success')

  // 9. 新分支可辨认来源，可返回来源
  await waitFor(() => evaluate('Boolean(document.querySelector("[data-testid=fork-source]"))'), '顶栏来源标识')
  assert.equal(
    await evaluate('document.querySelector("[data-testid=fork-source]").innerText.trim()'),
    '返回',
    '顶栏应显示短文案“返回”',
  )
  assert.equal(
    await evaluate(
      'document.querySelector("[data-testid=fork-source]").getAttribute("aria-label").includes("返回来源会话")',
    ),
    true,
    '顶栏应保留完整的 aria-label',
  )
  await waitFor(() => evaluate('Boolean(document.querySelector("[aria-label=\\"分叉自其他会话\\"]"))'), '侧栏分叉标识')

  // 10. 新分支续聊，且不写入原会话
  await send('Fork 分支续聊')
  await waitReply('已回复：Fork 分支续聊')
  assert.deepEqual(await userTexts(), ['第一轮编辑版', 'Fork 分支续聊'], 'Fork 只包含截至所选回复的上下文')
  await capture('06-fork-chat')

  // 11. 返回来源会话，原会话与草稿保持
  await click('[data-testid=fork-source]')
  await waitFor(async () => JSON.stringify(await userTexts()) === JSON.stringify(['第一轮编辑版']), '返回来源会话')
  assert.equal(await composerText(), '未发送草稿：请保留这段文字', '返回来源后原会话草稿应保留')
  assert.equal(
    await evaluate('document.querySelectorAll("[data-testid=fork-source]").length'),
    0,
    '原会话不应显示分叉来源',
  )
  await capture('07-back-to-source')
}

;(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-edit-fork-smoke-'))
  app.setPath('userData', directory)
  process.env.PI_MEME_DATA_ROOT = directory
  process.env.PI_MEME_TEST_CREDENTIALS = 'memory'
  const { startSmokeAgent } = await import('./smoke-agent.mjs')
  await startSmokeAgent(directory)
  await fs.writeFile(
    path.join(directory, 'test-credentials.json'),
    JSON.stringify({
      'model-provider:fake': JSON.stringify({ credential: { type: 'api_key', key: 'test' } }),
    }),
    { mode: 0o600 },
  )
  await fs.writeFile(path.join(directory, 'settings.json'), JSON.stringify({ themeId: 'dark' }))
  app.once('browser-window-created', (_event, window) => {
    window.webContents.once('did-finish-load', () => {
      run(window)
        .catch(async (error) => {
          failed = true
          console.error(error)
          await fs.mkdir(shots, { recursive: true }).catch(() => {})
          await fs
            .writeFile(path.join(shots, 'failed.png'), (await window.webContents.capturePage()).toPNG())
            .catch(() => {})
          console.error(await window.webContents.executeJavaScript('document.body.innerText.slice(0, 3000)'))
        })
        .finally(() => app.quit())
    })
  })
  app.on('will-quit', () => {
    void fs.rm(directory, { recursive: true, force: true })
    app.exit(failed ? 1 : 0)
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
