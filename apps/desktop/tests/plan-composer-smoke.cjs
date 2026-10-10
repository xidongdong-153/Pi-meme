const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { app, clipboard } = require('electron')

module.exports = async (window, waitFor, directory, screenshots, options = {}) => {
  const evaluate = (code) => window.webContents.executeJavaScript(code)
  const clickText = (text, scope = 'body') =>
    evaluate(`(() => {
      const button = [...document.querySelector(${JSON.stringify(scope)}).querySelectorAll('button')].find(node => node.textContent.trim() === ${JSON.stringify(text)});
      if (!button) throw new Error('找不到按钮：' + ${JSON.stringify(text)}); button.click();
    })()`)
  const draft = (text) =>
    evaluate(`(() => {
      const node = document.querySelector('[contenteditable=true][aria-label=消息]');
      node.textContent = ${JSON.stringify(text)}; node.focus();
      const range = document.createRange(); range.selectNodeContents(node); range.collapse(false);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      node.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
  const capture =
    options.capture ??
    (async (name) => {
      assert.equal(
        await evaluate('document.querySelector("section[aria-label=工作区] button[aria-label=关闭错误提示]") === null'),
        true,
        '协作和计划验收没有主会话错误提示',
      )
      assert.equal(
        await evaluate('document.querySelector("section[aria-label=工作区] [role=alert]") === null'),
        true,
        '主会话没有错误正文',
      )
      await evaluate(`(() => {
      const flow = document.querySelector('section[aria-label="工作区"] [aria-label="对话消息流"]');
      if (!flow) return;
      flow.scrollTo({ top: flow.scrollHeight, behavior: 'instant' });
      flow.dispatchEvent(new Event('scroll'));
    })()`)
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      if (name === 'plan-preview' || name === 'plan-copied' || name === 'plan-exported')
        assert.equal(
          await evaluate(`(() => {
          const flow = document.querySelector('aside[aria-label="右侧栏"] [aria-label="计划文档"]');
          const bounds = flow.getBoundingClientRect();
          const card = flow.querySelector('section[aria-label="已保存计划：桌面验收计划"]');
          const rect = card?.getBoundingClientRect();
          return Boolean(rect && rect.height > 0 && rect.top >= bounds.top && rect.bottom <= bounds.bottom && rect.bottom <= window.innerHeight);
        })()`),
          true,
          '截图中的右栏计划全文完整可见',
        )
      await fs.writeFile(path.join(screenshots, `${name}.png`), (await window.webContents.capturePage()).toPNG())
    })
  const countUsers =
    options.countUsers ??
    (() =>
      evaluate(
        'window.piMemeClient.getSnapshot().then(value => value.messages.filter(message => message.role === "user").length)',
      ))
  const coldKey = options.cold
    ? await evaluate('window.piMemeClient.getConnection().then(value => value.sessionKey)')
    : undefined
  const commandUsers = await countUsers()
  const editorSelector = '[contenteditable=true][aria-label=消息]'
  const key = (key, options = {}) =>
    evaluate(
      `document.querySelector(${JSON.stringify(editorSelector)}).dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({ key, bubbles: true, cancelable: true, ...options })}))`,
    )
  const modeReady = (mode) =>
    waitFor(
      () =>
        evaluate(`window.piMemeClient.getSnapshot().then(value => {
        const button = document.querySelector('button[aria-label="关闭计划模式"]');
        const access = document.querySelector('[aria-label="Agent 访问权限"]');
        const divider = access?.parentElement.parentElement.querySelector('span[aria-hidden="true"]');
        const inactive = [...document.querySelectorAll('form[aria-label="消息输入"] button')].some(node =>
          node.getAttribute('aria-label') === '开启计划模式' || node.textContent.trim() === '计划');
        return value.state.mode === '${mode}' && !value.state.isStreaming &&
          ${mode === 'plan' ? 'button && !button.disabled' : '!button && !inactive && !divider'};
      })`),
      `${mode} 计划工具栏可操作`,
    )
  const planLayout = async () => {
    assert.equal(
      await evaluate(`(() => {
        const editor = document.querySelector(${JSON.stringify(editorSelector)});
        const access = document.querySelector('[aria-label="Agent 访问权限"]');
        const plan = document.querySelector('button[aria-label="关闭计划模式"]');
        const group = access?.parentElement.parentElement;
        const accessBounds = access?.getBoundingClientRect();
        const bounds = plan?.getBoundingClientRect();
        return Boolean(plan && group?.contains(plan) && Boolean(editor.compareDocumentPosition(plan) & Node.DOCUMENT_POSITION_FOLLOWING) &&
          bounds.top >= editor.getBoundingClientRect().bottom && bounds.left >= accessBounds.right - 1 &&
          plan.textContent.trim() === '计划' && plan.querySelector('.lucide-x') && plan.querySelector('.lucide-lightbulb'));
      })()`),
      true,
      '计划入口位于消息编辑器之后、权限右侧的同一工具栏组',
    )
  }
  await modeReady('default')
  await require('./composer-layout-smoke.cjs')(window, () => modeReady('default'))
  for (const prefix of ['/', '/计', '/计划', '/计划模式', '/pl']) {
    await draft(prefix)
    await waitFor(
      () => evaluate('Boolean(document.querySelector("#composer-suggestions [title=plan]"))'),
      `${prefix} 规范计划候选`,
    )
    const candidates = await evaluate(`(() => {
      const options = [...document.querySelectorAll('#composer-suggestions [role=option]')];
      return options.map(node => ({ name: node.querySelector('span[title]').textContent, builtin: node.textContent.includes('内置') }));
    })()`)
    assert.deepEqual(
      candidates.filter((item) => /^\/(?:plan|计划.*)$/.test(item.name)),
      [{ name: '/plan', builtin: true }],
    )
    if (prefix !== '/') assert.equal(candidates.length, 1, `${prefix} 只展示规范 /plan 候选`)
    assert.equal(
      await evaluate('document.querySelector("#composer-suggestions").textContent.includes("/计划模式")'),
      false,
    )
    if (prefix === '/') await capture('plan-command-suggestions')
  }
  await draft('/计')
  await waitFor(
    () => evaluate('Boolean(document.querySelector("#composer-suggestions [title=plan]"))'),
    '输入法计划候选',
  )
  await evaluate(
    `document.querySelector(${JSON.stringify(editorSelector)}).dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))`,
  )
  await key('Enter', { isComposing: true })
  assert.equal(
    await evaluate('Boolean(document.querySelector("button[aria-label=关闭计划模式]"))'),
    false,
    '输入法确认不会启用计划',
  )
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(editorSelector)}).textContent`), '/计')
  await evaluate(
    `document.querySelector(${JSON.stringify(editorSelector)}).dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))`,
  )
  assert.equal(await key('Enter', { shiftKey: true }), false, 'Shift+Enter 保持插入换行')
  assert.equal(
    await evaluate(`(() => {
    const editor = document.querySelector(${JSON.stringify(editorSelector)});
    return editor.textContent.startsWith('/计') && (editor.innerHTML.includes('<br>') || editor.textContent.includes('\\n'));
  })()`),
    true,
  )
  await modeReady('default')
  for (const [prefix, confirmation] of [
    ['/计划', 'Enter'],
    ['/pl', 'Tab'],
    ['/计划模式', 'mouse'],
  ]) {
    await draft(prefix)
    await waitFor(
      () => evaluate('Boolean(document.querySelector("#composer-suggestions [title=plan]"))'),
      `${confirmation} 计划候选`,
    )
    if (confirmation === 'mouse')
      await evaluate('document.querySelector("#composer-suggestions [title=plan]").closest("button").click()')
    else await key(confirmation)
    await modeReady('plan')
    assert.equal(
      await evaluate(`document.querySelector(${JSON.stringify(editorSelector)}).textContent`),
      '',
      `${confirmation} 消费计划命令`,
    )
    assert.equal(await evaluate('document.querySelector("#composer-suggestions") === null'), true)
    await planLayout()
    await draft('计划切换保留的草稿')
    await evaluate('document.querySelector("button[aria-label=关闭计划模式]").click()')
    await modeReady('default')
    assert.equal(
      await evaluate(`document.querySelector(${JSON.stringify(editorSelector)}).textContent`),
      '计划切换保留的草稿',
    )
  }
  assert.equal(await countUsers(), commandUsers, '候选确认、输入法与切换模式不发送消息')
  await capture('plan-toolbar-closed')
  await draft('/plan')
  await waitFor(
    () => evaluate('Boolean(document.querySelector("#composer-suggestions [title=plan]"))'),
    '重新启用计划候选',
  )
  await key('Enter')
  await modeReady('plan')
  await draft('计划切换保留的草稿')
  const hoverPlan = async (hover) => {
    const selector = hover ? 'button[aria-label="关闭计划模式"]' : editorSelector
    const point = await evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      const rect = node.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()`)
    window.webContents.sendInputEvent({ type: 'mouseMove', ...point })
    await waitFor(
      () =>
        evaluate(`(() => {
        const button = document.querySelector('button[aria-label="关闭计划模式"]');
        const close = button.querySelector('.lucide-x').parentElement;
        const bulb = button.querySelector('.lucide-lightbulb');
        return getComputedStyle(close).display === '${hover ? 'flex' : 'none'}' &&
          ${hover ? "getComputedStyle(bulb).display === 'none'" : "getComputedStyle(bulb).display !== 'none'"};
      })()`),
      hover ? '真实鼠标悬停显示关闭 X' : '自然态隐藏关闭 X 并显示灯泡',
    )
  }
  await planLayout()
  await hoverPlan(false)
  await capture('plan-toolbar-active')
  const pillSize = () =>
    evaluate(`(() => {
    const rect = document.querySelector('button[aria-label="关闭计划模式"]').getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  })()`)
  const naturalSize = await pillSize()
  await hoverPlan(true)
  assert.deepEqual(await pillSize(), naturalSize, '悬停显示关闭 X 不改变计划胶囊尺寸')
  await capture('plan-toolbar-hover')
  await hoverPlan(false)
  await require('./composer-layout-smoke.cjs')(window, async (name) => {
    await planLayout()
    if (name === 'composer-layout-320') {
      await hoverPlan(false)
      await capture('plan-toolbar-narrow')
    }
  })
  await capture('plan-mode')
  if (options.cold) {
    const beforeSend = await evaluate('window.piMemeClient.getSnapshot()')
    assert.equal(beforeSend.connection.status, 'idle', '候选和计划切换不启动 Worker')
    assert.equal(beforeSend.messages.length, 0, '首次发送前没有模型或用户消息')
    assert.equal(beforeSend.connection.sessionKey, coldKey, '计划操作保留新聊天身份')
  }
  await draft('plan-smoke')
  await waitFor(
    () =>
      evaluate(
        'window.piMemeClient.getSnapshot().then(value => value.state.mode === "plan" && !document.querySelector("button[aria-label=发送消息]").disabled)',
      ),
    '计划模式消息可发送',
  )
  const documentSession = await evaluate('window.piMemeClient.getConnection().then(value => value.sessionKey)')
  await evaluate('document.querySelector("button[aria-label=发送消息]").click()')
  const card = 'aside[aria-label="右侧栏"] section[aria-label="已保存计划：桌面验收计划"]'
  await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(card)}))`), '计划文档卡片')
  await waitFor(() => evaluate('window.piMemeClient.getSnapshot().then(value => !value.state.isStreaming)'), '计划完成')
  await waitFor(
    () =>
      evaluate(
        'document.querySelector("aside[aria-label=右侧栏] [role=tab][aria-selected=true]")?.textContent.trim() === "计划"',
      ),
    '实时保存计划自动打开计划标签',
  )
  assert.equal(
    await evaluate(
      `document.querySelector('section[aria-label="工作区"] section[aria-label="已保存计划：桌面验收计划"]') === null`,
    ),
    true,
    '主对话不显示计划卡片',
  )
  assert.equal(
    await evaluate(
      'document.querySelector("section[aria-label=工作区] [aria-label=对话消息流]").textContent.includes("确认改动范围。")',
    ),
    false,
    '计划正文仅在右侧栏显示',
  )
  const preservedDraft = '计划侧栏保留的草稿'
  await draft(preservedDraft)
  const assertRootTarget = async () => {
    assert.equal(
      await evaluate('window.piMemeClient.getConnection().then(value => value.sessionKey)'),
      documentSession,
      '查看计划不切换主输入目标',
    )
    assert.equal(
      await evaluate(`document.querySelector(${JSON.stringify(editorSelector)}).textContent`),
      preservedDraft,
      '查看和复制导出计划保留主草稿',
    )
  }
  await assertRootTarget()
  await clickText('会话树', 'aside[aria-label=右侧栏]')
  await waitFor(
    () =>
      evaluate(
        'document.querySelector("aside[aria-label=右侧栏] [role=tab][aria-selected=true]")?.textContent.trim() === "会话树"',
      ),
    '计划保存后可切到会话树',
  )
  await assertRootTarget()
  await clickText('计划', 'aside[aria-label=右侧栏]')
  await waitFor(
    () =>
      evaluate(
        `document.querySelector('aside[aria-label=右侧栏] [role=tab][aria-selected=true]')?.textContent.trim() === '计划' && Boolean(document.querySelector(${JSON.stringify(card)}))`,
      ),
    '切回计划保留文档',
  )
  await assertRootTarget()
  await capture('plan-preview')
  const snapshot = await evaluate('window.piMemeClient.getSnapshot()')
  const document = snapshot.planDocuments.find((entry) => entry.title === '桌面验收计划')
  assert.equal(
    await evaluate(
      `document.querySelector(${JSON.stringify(card)}).textContent.includes('查看工作区目录。') && document.querySelector(${JSON.stringify(card)}).textContent.includes('确认改动范围。') && document.querySelector(${JSON.stringify(card)}).textContent.includes('运行项目检查。')`,
    ),
    true,
    '右栏显示计划完整正文',
  )
  assert.equal(
    await evaluate(
      `document.querySelector(${JSON.stringify(card)}).querySelector('input, textarea, [contenteditable=true]') === null`,
    ),
    true,
    '计划正文只读',
  )
  if (options.cold) {
    assert.equal(snapshot.planDocuments.length, 1, '首次发送真实生成计划文档')
    assert.equal(
      await evaluate('document.querySelector("select[aria-label=选择计划文档]") === null'),
      true,
      '单篇计划不展示冗余选择器',
    )
  }
  assert.equal(
    await fs.readFile(path.join(directory, 'plans', document.sessionId, `${document.id}.md`), 'utf8'),
    document.markdown,
  )
  if (process.platform === 'darwin') app.focus({ steal: true })
  window.focus()
  window.webContents.focus()
  await waitFor(() => evaluate('document.hasFocus()'), '计划复制窗口获得焦点')
  await clickText('复制', card)
  await waitFor(
    () => evaluate(`document.querySelector(${JSON.stringify(card)}).textContent.includes('已复制')`),
    '复制计划',
  )
  assert.equal(await clipboard.readText(), document.markdown)
  await assertRootTarget()
  await capture('plan-copied')
  const exported = path.join(directory, 'exported-plan.md')
  const downloaded = new Promise((resolve, reject) => {
    window.webContents.session.once('will-download', (_event, item) => {
      item.setSavePath(exported)
      item.once('done', (_done, state) =>
        state === 'completed' ? resolve() : reject(new Error(`计划导出失败：${state}`)),
      )
    })
  })
  await clickText('导出 Markdown', card)
  await downloaded
  assert.equal(await fs.readFile(exported, 'utf8'), document.markdown)
  await assertRootTarget()
  await capture('plan-exported')
  await draft('plan-toolbar-default-smoke')
  await evaluate('document.querySelector("button[aria-label=关闭计划模式]").click()')
  await modeReady('default')
  assert.equal(
    await evaluate(`document.querySelector(${JSON.stringify(editorSelector)}).textContent`),
    'plan-toolbar-default-smoke',
  )
  await waitFor(
    () => evaluate('!document.querySelector("button[aria-label=发送消息]").disabled'),
    '退出计划后普通消息可发送',
  )
  await evaluate('document.querySelector("button[aria-label=发送消息]").click()')
  await waitFor(
    () =>
      evaluate(
        'window.piMemeClient.getSnapshot().then(value => value.state.mode === "default" && !value.state.isStreaming && JSON.stringify(value.messages).includes("已回复：plan-toolbar-default-smoke"))',
      ),
    '关闭计划后的下一轮采用普通模式',
  )
}
