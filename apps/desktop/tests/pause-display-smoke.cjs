const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')

module.exports = async (window, waitFor, directory, screenshots, agent) => {
  const evaluate = (code) => window.webContents.executeJavaScript(code)
  const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const work = '[aria-label="工作过程"]'
  const elapsed = () => evaluate(`document.querySelector('${work}').textContent.trim()`)
  const seconds = (text) => {
    const match = text.match(/工作了 (?:(\d+)小时)?(?:(\d+)分)?(?:(\d+)秒)?/)
    assert.ok(match, `工作过程包含时长：${text}`)
    return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0)
  }
  const capture = async (name) => {
    await fs.writeFile(path.join(screenshots, `${name}.png`), (await window.webContents.capturePage()).toPNG())
  }
  await waitFor(() => evaluate('Boolean(window.piMemeClient)'), '客户端就绪')
  const standalone = process.env.PI_DESKTOP_PAUSE_STANDALONE === '1'
  await evaluate(
    `window.piMemeClient.selectWorkspace(${JSON.stringify(standalone ? { kind: 'standalone' } : { kind: 'project', cwd: directory })})`,
  )
  await evaluate(`(() => {
    const node=document.querySelector('[aria-label="消息"][role="combobox"]');
    node.textContent='暂停显示专项验收'; node.dispatchEvent(new Event('input',{bubbles:true}));
  })()`)
  await waitFor(() => evaluate('document.querySelector("[aria-label=发送消息]")?.disabled === false'), '发送就绪')
  const started = Date.now()
  await click('[aria-label="发送消息"]')
  await waitFor(() => agent.provider.requests.length === 2, '目录工具完成，第二模型请求等待屏障')
  await waitFor(() => evaluate(`Boolean(document.querySelector('${work} .animate-spin'))`), '工作过程运行图标')
  await click(work)
  await waitFor(() => evaluate('Boolean(document.querySelector("[aria-label=思考过程]"))'), '展开思考和目录工具')
  const sessionPath = await evaluate('window.piMemeClient.getSessions().then(value => value.activeSessionPath)')
  const sessionRow = `aside [data-session-path=${JSON.stringify(sessionPath)}]`
  const runningIcons = () => evaluate(`document.querySelectorAll('${sessionRow} [aria-label="会话运行中"]').length`)
  await waitFor(async () => (await runningIcons()) > 0, '侧栏会话运行图标')
  const first = await elapsed()
  await sleep(2200)
  assert.ok(seconds(await elapsed()) > seconds(first), '运行时计时增长')
  await capture('pause-running')
  let pausedMs = 0
  const assertPaused = async (label) => {
    assert.equal(
      await evaluate('Boolean(document.querySelector("[aria-label=待处理任务队列]"))'),
      false,
      `${label}：空队列完全隐藏，包含暂停横幅`,
    )
    assert.equal(
      await evaluate('document.querySelector("form[aria-label=消息输入] button[aria-label=继续当前任务]")?.disabled'),
      false,
      `${label}：主输入框保留可用的播放恢复按钮`,
    )
    if (await evaluate(`document.querySelector('${work}').getAttribute('aria-expanded') === 'false'`)) {
      await click(work)
    }
    assert.equal(
      await evaluate(
        `([...document.querySelectorAll('[aria-label="思考过程"]')].at(-1)).querySelectorAll('svg:not(.lucide-chevron-down)').length`,
      ),
      0,
      `${label}：当前思考没有运行或替代状态图标`,
    )
    assert.equal(await runningIcons(), 0, `${label}：侧栏没有运行图标`)
    assert.equal(
      await evaluate('document.querySelectorAll("aside [aria-label=项目内有会话运行中]").length'),
      0,
      `${label}：项目聚合没有运行图标`,
    )
    assert.equal(
      await evaluate(`document.querySelector('${work}').querySelectorAll('svg:not(.lucide-chevron-down)').length`),
      0,
      `${label}：工作过程没有运行或替代状态图标`,
    )
    assert.equal(
      await evaluate('document.querySelectorAll("[aria-label=工作过程详情] .animate-spin").length'),
      0,
      `${label}：展开的思考和工具没有运行图标`,
    )
  }
  const pause = async (label, reconnect) => {
    await click('[aria-label="暂停当前任务"]')
    await waitFor(() => evaluate('Boolean(document.querySelector("[aria-label=继续当前任务]"))'), label)
    const pauseStarted = Date.now()
    const frozen = await elapsed()
    await capture(`pause-${label}`)
    await assertPaused(label)
    await sleep(3000)
    assert.equal(await elapsed(), frozen, `${label}：等待3秒计时完全不变`)
    if (reconnect) {
      await evaluate('window.piMemeClient.newSession()')
      await evaluate(`window.piMemeClient.switchSession(${JSON.stringify(sessionPath)})`)
      await waitFor(() => evaluate('Boolean(document.querySelector("[aria-label=继续当前任务]"))'), '切回暂停会话')
      assert.equal(await elapsed(), frozen, '切回仍冻结')
      await assertPaused('切回')
      await window.webContents.reload()
      await waitFor(() => evaluate('Boolean(document.querySelector("[aria-label=继续当前任务]"))'), '刷新恢复暂停')
      assert.equal(await elapsed(), frozen, '刷新仍冻结')
      await assertPaused('刷新')
      await evaluate(
        "window.__pauseConnection = 'ready'; void window.piMemeClient.onConnection(value => { window.__pauseConnection = value.status })",
      )
      window.webContents.debugger.attach('1.3')
      try {
        const prototype = await window.webContents.debugger.sendCommand('Runtime.evaluate', {
          expression: 'WebSocket.prototype',
        })
        const sockets = await window.webContents.debugger.sendCommand('Runtime.queryObjects', {
          prototypeObjectId: prototype.result.objectId,
        })
        await window.webContents.debugger.sendCommand('Runtime.callFunctionOn', {
          objectId: sockets.objects.objectId,
          functionDeclaration: 'function () { this.forEach(socket => socket.close()) }',
        })
      } finally {
        window.webContents.debugger.detach()
      }
      await waitFor(() => evaluate("window.__pauseConnection === 'disconnected'"), 'WebSocket真实断开')
      await waitFor(() => evaluate("window.__pauseConnection !== 'disconnected'"), 'WebSocket真实重连')
      await sleep(3000)
      assert.equal(
        await evaluate('window.piMemeClient.getSnapshot().then(value => value.state.isPaused)'),
        true,
        '重连快照保留暂停',
      )
      assert.equal(await elapsed(), frozen, '重连仍冻结')
      await assertPaused('重连')
    }
    assert.equal(agent.provider.requests.length, 2, '暂停、刷新、切换和重连不重发模型请求')
    await click('form[aria-label="消息输入"] [aria-label="继续当前任务"]')
    await waitFor(() => evaluate(`Boolean(document.querySelector('${work} .animate-spin'))`), '恢复工作过程运行图标')
    pausedMs += Date.now() - pauseStarted
    assert.ok(Math.abs(seconds(await elapsed()) - seconds(frozen)) <= 1, '恢复从冻结值继续')
    await waitFor(async () => (await runningIcons()) > 0, '恢复侧栏运行图标')
    await sleep(2100)
    assert.ok(seconds(await elapsed()) > seconds(frozen), '恢复后计时增长')
  }
  await pause('paused', true)
  await evaluate(`window.piMemeClient.togglePin(${JSON.stringify(sessionPath)})`)
  await waitFor(
    () => evaluate(`Boolean(document.querySelector('${sessionRow} button[aria-label^="取消置顶"]'))`),
    '会话置顶',
  )
  if (!standalone) {
    await evaluate(`window.piMemeClient.togglePin(${JSON.stringify(directory)})`)
    await waitFor(() => evaluate('Boolean(document.querySelector("aside [aria-label^=取消置顶项目]"))'), '项目置顶')
    assert.ok(
      (await evaluate('document.querySelectorAll("aside [aria-label=项目内有会话运行中]").length')) > 0,
      '置顶项目聚合运行图标',
    )
  }
  await pause('paused-again', false)
  await capture('pause-resumed')
  agent.releaseQueueReply()
  await waitFor(
    () =>
      evaluate('window.piMemeClient.getSnapshot().then(value => !value.state.isStreaming && !value.state.isPaused)'),
    '恢复后完成',
  )
  const finished = seconds(await elapsed())
  const expected = (Date.now() - started - pausedMs) / 1000
  assert.ok(
    Math.abs(finished - expected) <= 2,
    `完成时长扣除两次暂停：显示${finished}秒，实际活动${expected.toFixed(1)}秒`,
  )
  assert.equal(agent.provider.requests.length, 2, '恢复不新增模型请求')
  assert.equal(
    await evaluate(
      'window.piMemeClient.getSnapshot().then(value => value.messages.filter(message => message.role === "user").length)',
    ),
    1,
    '恢复不增加继续用户消息',
  )
  await capture('pause-complete')
  console.log('暂停桌面验收通过：运行图标、冻结计时、两次暂停、切换、刷新、重连和完成时长')
}
