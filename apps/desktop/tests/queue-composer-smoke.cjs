const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')

module.exports = async (window, waitFor, directory, screenshots, agent) => {
  const evaluate = (code) => window.webContents.executeJavaScript(code)
  const editor = '[aria-label="消息"][role="combobox"]'
  const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const draft = (text) =>
    evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(editor)}); node.textContent = ${JSON.stringify(text)}; node.focus();
    const range = document.createRange(); range.selectNodeContents(node); range.collapse(false);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  const queue = '[aria-label="待处理任务队列"]'
  const rows = () => evaluate(`document.querySelectorAll('${queue} [data-queue-id]').length`)
  const capture = async (name) => {
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    await fs.writeFile(path.join(screenshots, `${name}.png`), (await window.webContents.capturePage()).toPNG())
  }
  const more = async () => {
    await evaluate(
      `document.querySelector('${queue} button[aria-label="排队消息更多操作"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`,
    )
    await waitFor(() => evaluate('Boolean(document.querySelector("[role=menuitem]"))'), '打开队列菜单')
    assert.equal(await evaluate('document.querySelectorAll("[role=menuitem]").length'), 1)
    assert.equal(await evaluate('document.querySelector("[role=menuitem]").textContent.trim()'), '编辑消息')
    await click('[role=menuitem]')
    await waitFor(() => evaluate('Boolean(document.querySelector("button[aria-label=保存排队消息]"))'), '回填队列编辑')
  }
  await waitFor(
    () => evaluate('Boolean(window.piMemeClient && document.querySelector("button[aria-label=发送消息]"))'),
    '初始输入框',
  )
  await draft('队列验收：运行中的第一条任务')
  await waitFor(
    () => evaluate('document.querySelector("button[aria-label=发送消息]")?.disabled === false'),
    '首条消息发送就绪',
  )
  await click('button[aria-label="发送消息"]')
  await waitFor(() => evaluate('Boolean(document.querySelector("button[aria-label=暂停当前任务]"))'), '模型持续运行')
  await waitFor(() => agent.provider.requests.length === 1, '首请求进入屏障')
  await click('button[aria-label="暂停当前任务"]')
  const resume = 'form[aria-label="消息输入"] button[aria-label="继续当前任务"]'
  await waitFor(() => evaluate(`document.querySelector(${JSON.stringify(resume)})?.disabled === false`), '空队列暂停')
  assert.equal(await evaluate(`Boolean(document.querySelector('${queue}'))`), false, '空队列暂停时隐藏全部队列')
  await capture('queue-paused-empty')
  await draft('暂停时添加后删除的队列消息')
  await click('button[aria-label="发送排队任务"]')
  await waitFor(async () => (await rows()) === 1, '暂停时添加队列')
  assert.equal(
    await evaluate(`document.querySelector('${queue}').textContent.includes('队列已暂停')`),
    true,
    '存在排队条目时显示暂停横幅',
  )
  await click(`${queue} button[aria-label="删除排队消息"]`)
  await waitFor(() => evaluate(`!document.querySelector('${queue}')`), '删除最后一条后隐藏队列与暂停横幅')
  assert.equal(
    await evaluate('window.piMemeClient.getSnapshot().then(value => value.state.isPaused)'),
    true,
    '删除最后一条队列仍保留暂停状态',
  )
  assert.equal(agent.provider.requests.length, 1, '暂停时添加和删除不新增模型请求')
  await click(resume)
  await waitFor(
    () => evaluate('Boolean(document.querySelector("button[aria-label=暂停当前任务]"))'),
    '空队列主输入框播放按钮恢复',
  )
  const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jOtkAAAAASUVORK5CYII='
  const delayImage = () =>
    evaluate(`(() => {
    window.__pendingReaders = [];
    window.__originalFileReader ??= window.FileReader;
    window.FileReader = class extends window.__originalFileReader {
      readAsDataURL(file) { window.__pendingReaders.push(() => new Promise(resolve => { this.addEventListener('loadend', resolve, { once: true }); super.readAsDataURL(file) })) }
    };
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(atob('${image}'), char => char.charCodeAt(0))], 'late.png', { type: 'image/png' }));
    const input = document.querySelector('form input[type=file]'); input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`)
  const completeImage = () =>
    evaluate(`new Promise(resolve => {
    window.FileReader = window.__originalFileReader;
    Promise.all(window.__pendingReaders.map(complete => complete())).then(() => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })`)
  await evaluate(`(() => {
    const transfer = new DataTransfer();
    for (let index=0; index<3; index++) transfer.items.add(new File([Uint8Array.from(atob('${image}'), char => char.charCodeAt(0))], 'queue-'+index+'.png', { type: 'image/png' }));
    const input = document.querySelector('form[aria-label="消息输入"] input[type=file]'); input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`)
  await waitFor(() => evaluate('document.querySelectorAll("form img").length === 3'), '附加三张图片')
  await draft('长队列消息用于检查窄屏截断和图片编辑保留，正文不应撑开输入区域。')
  await click('button[aria-label="发送排队任务"]')
  await waitFor(async () => (await rows()) === 1, '第一条后续队列')
  const id = await evaluate(`document.querySelector('${queue} [data-queue-id]').dataset.queueId`)
  await draft('编辑前的草稿')
  await more()
  assert.equal(await evaluate('document.querySelectorAll("form img").length'), 3, '编辑恢复所有图片')
  assert.equal(await evaluate(`document.querySelector('${queue}').textContent.includes('正在编辑：')`), true)
  await draft('')
  // 通过主输入器的移除按钮逐次删除，避免批处理旧状态覆盖。
  while (await evaluate('document.querySelectorAll("form img").length')) {
    await evaluate(`document.querySelector('form img').parentElement.querySelector('button').click()`)
    await evaluate('new Promise(resolve => requestAnimationFrame(resolve))')
  }
  assert.equal(
    await evaluate('document.querySelector("button[aria-label=保存排队消息]").disabled'),
    true,
    '空编辑不能暂停或恢复',
  )
  await delayImage()
  await evaluate(
    `document.querySelector(${JSON.stringify(editor)}).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
  )
  await waitFor(
    () => evaluate(`document.querySelector(${JSON.stringify(editor)}).textContent === '编辑前的草稿'`),
    'Escape取消编辑恢复草稿',
  )
  assert.equal(await rows(), 1, 'Escape保留队列')
  assert.equal(await evaluate('document.querySelectorAll("form img").length'), 0, '取消后恢复原草稿附件')
  await more()
  await completeImage()
  assert.equal(
    await evaluate('document.querySelectorAll("form img").length'),
    3,
    '取消后的迟到图片不能加入下一次编辑，编辑状态ABA也须隔离',
  )
  await draft('已编辑的队列消息')
  await delayImage()
  await click('button[aria-label="保存排队消息"]')
  await waitFor(
    () => evaluate(`document.querySelector(${JSON.stringify(editor)}).textContent === '编辑前的草稿'`),
    '保存后恢复前草稿',
  )
  await completeImage()
  assert.equal(await evaluate('document.querySelectorAll("form img").length'), 0, '保存编辑后的迟到图片不能加入旧草稿')
  assert.equal(
    await evaluate(`document.querySelector('${queue} [data-queue-id]').dataset.queueId`),
    id,
    '保存保留队列身份和位置',
  )
  assert.equal(
    await evaluate(`document.querySelector('${queue} [data-queue-id]').textContent.includes('已编辑的队列消息')`),
    true,
  )
  await draft('待删除队列')
  await click('button[aria-label="发送排队任务"]')
  await waitFor(async () => (await rows()) === 2, '第二条排队')
  await evaluate(`document.querySelectorAll('${queue} button[aria-label="删除排队消息"]')[1].click()`)
  await waitFor(async () => (await rows()) === 1, '逐条删除')
  await draft('')
  await click('button[aria-label="暂停当前任务"]')
  await waitFor(() => evaluate('Boolean(document.querySelector("button[aria-label=继续当前任务]"))'), '暂停恢复入口')
  assert.equal(
    await evaluate(`document.querySelector('${queue}').textContent.includes('队列已暂停')`),
    true,
    '已有排队条目暂停时保留横幅',
  )
  await click('button[aria-label="继续当前任务"]')
  await waitFor(
    () => evaluate('Boolean(document.querySelector("button[aria-label=暂停当前任务]"))'),
    '主按钮Play恢复模型',
  )
  assert.equal(await rows(), 1, '恢复仍保留当前运行后的队列')
  await click('button[aria-label="暂停当前任务"]')
  await waitFor(() => evaluate('Boolean(document.querySelector("button[aria-label=继续当前任务]"))'), '再次暂停')
  const requestsPaused = agent.provider.requests.length
  const originalWidth = await evaluate(`document.querySelector('[data-testid="composer-area"]').style.width`)
  for (const width of [620, 420, 320]) {
    await evaluate(`document.querySelector('[data-testid="composer-area"]').style.width='${width}px'`)
    await capture(`queue-paused-${width}`)
    assert.equal(
      await evaluate(`(() => {
      const area=document.querySelector('[data-testid="composer-area"]');
      const bounds=area.getBoundingClientRect();
      return area.scrollWidth <= area.clientWidth + 1 && [...area.querySelectorAll('button')].every(node => {
        const rect=node.getBoundingClientRect();return !rect.width || (rect.left >= bounds.left-1 && rect.right <= bounds.right+1);
      });
    })()`),
      true,
      `${width}px 队列与控制按钮不溢出`,
    )
  }
  await evaluate(`document.querySelector('[data-testid="composer-area"]').style.width=${JSON.stringify(originalWidth)}`)
  await evaluate(
    "window.__queueConnection = 'ready'; void window.piMemeClient.onConnection(value => { window.__queueConnection = value.status })",
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
  await waitFor(() => evaluate("window.__queueConnection === 'disconnected'"), '网络断开触发真实WebSocket重连')
  await waitFor(
    () =>
      evaluate(
        "window.__queueConnection !== 'disconnected' && Boolean(document.querySelector('button[aria-label=继续当前任务]'))",
      ),
    '网络恢复重新投影暂停',
  )
  assert.equal(await rows(), 1, '重连保留队列')
  assert.equal(agent.provider.requests.length, requestsPaused, '暂停和重连不新增模型请求')
  await capture('queue-paused-reconnected')
  await window.webContents.reload()
  await waitFor(
    () => evaluate('Boolean(document.querySelector("button[aria-label=继续当前任务]"))'),
    '页面刷新恢复暂停',
  )
  assert.equal(await rows(), 1, '页面刷新保留原队列')
  assert.equal(agent.provider.requests.length, requestsPaused, '刷新不新增模型请求')
  await capture('queue-paused-reloaded')
  await click(`${queue} button[aria-label="引导"]`)
  await waitFor(
    () =>
      evaluate(`window.piMemeClient.getSnapshot().then(value => {
    const update=value.events?.filter(record => record.event.type === 'queue_update').at(-1)?.event;
    return !value.state.isPaused && update?.steering.some(input => input.id === ${JSON.stringify(id)});
  })`),
    '暂停时引导移交选中项并恢复',
  )
  agent.releaseQueueReply()
  await waitFor(async () => (await rows()) === 0, '模型checkpoint处理选中排队项')
  await waitFor(
    () =>
      evaluate(
        'window.piMemeClient.getSnapshot().then(value => !value.state.isStreaming && !value.state.isPaused && value.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes("已编辑的队列消息")))',
      ),
    '引导后恢复执行并完成',
  )
  assert.ok(agent.provider.requests.length >= 2, '选中排队项进入模型')
  await capture('queue-guided-complete')
  console.log('队列桌面验收通过：图片编辑、原草稿恢复、逐条删除、暂停、重连、引导和窄屏布局')
}
