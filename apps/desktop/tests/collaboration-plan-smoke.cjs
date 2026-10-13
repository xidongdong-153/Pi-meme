const { openTool } = require('./tool-tabs-smoke.cjs')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')

module.exports = async (window, waitFor, directory, screenshots) => {
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
  const agentAppearance = async (scope, rowSelector, title) => {
    const appearance = await evaluate(`(() => {
      const row = [...document.querySelector(${JSON.stringify(scope)}).querySelectorAll(${JSON.stringify(rowSelector)})].find(node => node.textContent.includes(${JSON.stringify(title)}));
      const avatar = row?.querySelector('[data-agent-avatar]');
      return { text: row?.textContent, variant: avatar?.getAttribute('data-variant'), hidden: avatar?.getAttribute('aria-hidden') };
    })()`)
    assert.ok(appearance.text?.includes(title), `子代理显示任务标题：${title}`)
    assert.match(appearance.variant ?? '', /^\d+$/, `子代理具有头像：${title}`)
    assert.equal(appearance.hidden, 'true', '装饰头像不重复朗读子代理名称')
    return appearance.variant
  }
  const capture = async (name) => {
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
      flow.scrollTo({ top: flow.scrollHeight, behavior: 'instant' });
      flow.dispatchEvent(new Event('scroll'));
    })()`)
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    if (name === 'agents-completed' || name.startsWith('agent-'))
      assert.equal(
        await evaluate(`(() => {
          const flow = document.querySelector('section[aria-label="工作区"] [aria-label="对话消息流"]');
          const stage = [...flow.querySelectorAll('[aria-label="子代理状态"]')].at(-1);
          const bounds = flow.getBoundingClientRect();
          const rect = stage?.getBoundingClientRect();
          return Boolean(rect && rect.height > 0 && rect.top >= bounds.top && rect.bottom <= bounds.bottom);
        })()`),
        true,
        '截图中的完成阶段位于主消息流可视区域',
      )
    if (name === 'plan-preview' || name === 'plan-copied' || name === 'plan-exported')
      assert.equal(
        await evaluate(`(() => {
          const flow = document.querySelector('#workspace-right-sidebar [aria-label="计划文档"]');
          const bounds = flow.getBoundingClientRect();
          const card = flow.querySelector('section[aria-label="已保存计划：桌面验收计划"]');
          const rect = card?.getBoundingClientRect();
          return Boolean(rect && rect.height > 0 && rect.top >= bounds.top && rect.bottom <= bounds.bottom && rect.bottom <= window.innerHeight);
        })()`),
        true,
        '截图中的右栏计划全文完整可见',
      )
    await fs.writeFile(path.join(screenshots, `${name}.png`), (await window.webContents.capturePage()).toPNG())
  }
  const root = await evaluate('window.piMemeClient.getConnection().then(value => value.sessionKey)')
  await draft('collaboration-smoke')
  await evaluate('document.querySelector("button[aria-label=发送消息]").click()')
  await openTool(window, waitFor, '子代理')
  await waitFor(
    () => evaluate('Boolean(document.querySelector("section[aria-label=运行中子代理] button"))'),
    '运行中子代理列表',
  )
  const runningInspectorAvatar = await agentAppearance('section[aria-label=运行中子代理]', 'button', 'Inspector')
  await capture('agents-running')
  await waitFor(
    () =>
      evaluate(
        'window.piMemeClient.getSnapshot().then(value => !value.state.isStreaming && JSON.stringify(value.messages).includes("父任务已读取子代理两轮结果"))',
      ),
    '父子两轮完成',
  )
  await waitFor(
    () =>
      evaluate(
        '[...document.querySelectorAll("section[aria-label=已结束子代理] button")].some(node => node.textContent.includes("Inspector"))',
      ),
    '已结束子代理列表',
  )
  const agents = await evaluate(`window.piMemeClient.getAgents(${JSON.stringify(root)})`)
  assert.equal(agents.filter((agent) => agent.parentAgentId).length, 1, 'followup 保留同一子代理身份')
  const inspector = agents.find((agent) => agent.name === 'inspector')
  const own = await evaluate(`window.piMemeClient.getAgentSnapshot(${JSON.stringify(inspector.agentId)})`)
  const listing = own.messages.find((message) => message.role === 'toolResult' && message.toolName === 'ls')
  assert.ok(listing, '子代理保留真实目录工具结果')
  assert.equal(listing.isError, false, '子代理目录工具执行成功')
  assert.match(JSON.stringify(listing.content), /README\.md/, '目录结果包含实际工作区 fixture 文件')
  const rootMessages = await evaluate('document.querySelector("main [aria-label=对话消息流]").textContent')
  assert.equal(
    rootMessages.includes('子代理第一轮完整回复') || rootMessages.includes('子代理第二轮完整回复'),
    false,
    '主会话隐藏原始子报告',
  )
  for (const agent of agents.filter((entry) => entry.parentAgentId))
    assert.equal(rootMessages.includes(agent.agentId), false, '主会话隐藏协作身份')
  assert.equal(
    await evaluate(
      '[...document.querySelectorAll("main [aria-label=子代理状态]")].some(node => node.textContent.trim() === "Inspector 已完成")',
    ),
    true,
    '主会话只显示简短完成阶段',
  )
  const completedInspectorAvatar = await agentAppearance('section[aria-label=已结束子代理]', 'button', 'Inspector')
  const mainInspectorAvatar = await agentAppearance(
    'main [aria-label=对话消息流]',
    '[aria-label=子代理状态]',
    'Inspector',
  )
  assert.equal(completedInspectorAvatar, runningInspectorAvatar, '同一子代理完成后保留运行时图标')
  assert.equal(mainInspectorAvatar, completedInspectorAvatar, '主对话和右栏中的子代理图标一致')
  const inspectorStages = await evaluate(`(() => {
    const stages = [...document.querySelectorAll('main [aria-label="子代理状态"]')].filter(node => node.textContent.trim() === 'Inspector 已完成');
    return stages.map(node => node.querySelector('[data-agent-avatar]')?.getAttribute('data-variant'));
  })()`)
  assert.equal(inspectorStages.length, 2, '同一子代理的两轮任务分别显示完成阶段')
  assert.equal(
    inspectorStages.every((variant) => variant === completedInspectorAvatar),
    true,
    '继续子任务保持同一图标',
  )
  const listText = await evaluate('document.querySelector("section[aria-label=已结束子代理]").textContent')
  for (const agent of agents.filter((entry) => entry.parentAgentId)) {
    for (const value of [agent.agentId, agent.taskPath, agent.task, agent.report, agent.error].filter(Boolean))
      assert.equal(listText.includes(value), false, '列表只显示名称、状态与时长')
  }
  await capture('agents-completed')
  await evaluate('document.querySelector("section[aria-label=已结束子代理] button").click()')
  const panel = '#workspace-right-sidebar'
  await waitFor(
    () => evaluate(`document.querySelector(${JSON.stringify(panel)})?.textContent.includes('子代理第二轮完整回复')`),
    '子代理完整对话',
  )
  const detailInspectorAvatar = await agentAppearance(panel, 'header', 'Inspector')
  assert.equal(detailInspectorAvatar, completedInspectorAvatar, '子代理详情保留列表中的名称和图标')
  assert.equal(
    await evaluate(`document.querySelector(${JSON.stringify(panel)}).textContent.includes('子代理第一轮完整回复')`),
    true,
  )
  assert.equal(
    await evaluate(
      `document.querySelector(${JSON.stringify(panel)}).querySelector('[aria-label="编辑消息"], [aria-label="从这段回复新建会话"], [contenteditable=true]') === null`,
    ),
    true,
    '子代理详情只读',
  )
  assert.equal(
    await evaluate(`document.querySelector(${JSON.stringify(panel)}).textContent.includes('collaboration-smoke')`),
    false,
    'forkall 详情不展示继承的父输入',
  )
  assert.equal(await evaluate('window.piMemeClient.getConnection().then(value => value.sessionKey)'), root)
  await evaluate(`document.querySelector(${JSON.stringify(panel)}).querySelector('[aria-label="工作过程"]').click()`)
  await waitFor(
    () =>
      evaluate(
        `Boolean(document.querySelector(${JSON.stringify(panel)}).querySelector('[aria-label="工具详情：ls"]'))`,
      ),
    '子代理工具过程',
  )
  await capture('agent-conversation')
  await clickText('返回列表', panel)
  await evaluate('document.querySelector("button[aria-label=收起右侧栏]").click()')

  const beforeSummary = await evaluate('window.piMemeClient.getSnapshot()')
  const parentFile = beforeSummary.connection.sessionFile
  const userEntries = (content) =>
    content
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.type === 'message' && entry.message.role === 'user')
  const userCount = userEntries(await fs.readFile(parentFile, 'utf8')).length
  await draft('collaboration-summary-smoke')
  await evaluate('document.querySelector("button[aria-label=发送消息]").click()')
  await waitFor(
    () =>
      evaluate(
        `window.piMemeClient.getAgents(${JSON.stringify(root)}).then(items => items.some(agent => agent.name === 'summarizer' && agent.status === 'running'))`,
      ),
    '自动汇总子任务启动',
  )
  await draft('保留的草稿')
  await waitFor(
    () =>
      evaluate(
        'window.piMemeClient.getSnapshot().then(value => !value.state.isStreaming && JSON.stringify(value.messages).includes("自动汇总最终结论"))',
      ),
    '内部自动继续汇总',
  )
  assert.equal(
    await evaluate('document.querySelector("[contenteditable=true][aria-label=消息]").textContent'),
    '保留的草稿',
    '内部继续不会写入用户草稿',
  )
  const afterUsers = userEntries(await fs.readFile(parentFile, 'utf8'))
  assert.equal(afterUsers.length, userCount + 1, '自动继续不创建假的用户消息')
  const summaryMessages = await evaluate('document.querySelector("main [aria-label=对话消息流]").textContent')
  for (const value of [
    'AUTO-CHILD-RAW-REPORT',
    '子 Agent 已返回结果，请结合已保存的协作消息检查并继续当前任务。',
    '[来自 ',
  ])
    assert.equal(summaryMessages.includes(value), false, '主会话隐藏内部控制与原始报告')
  await waitFor(
    () =>
      evaluate(
        '[...document.querySelectorAll("main [aria-label=子代理状态]")].some(node => node.textContent.trim() === "Summarizer 已完成")',
      ),
    '自动汇总完成阶段',
  )
  await capture('agent-summary-stages')
  await openTool(window, waitFor, '子代理')
  await waitFor(
    () =>
      evaluate(
        '[...document.querySelectorAll("section[aria-label=已结束子代理] button")].some(node => node.textContent.includes("Summarizer"))',
      ),
    '最终简短列表',
  )
  assert.equal(
    await evaluate(
      'document.querySelector("section[aria-label=已结束子代理]").textContent.includes("AUTO-CHILD-RAW-REPORT")',
    ),
    false,
  )
  const summarizerAvatar = await agentAppearance('section[aria-label=已结束子代理]', 'button', 'Summarizer')
  const mainSummarizerAvatar = await agentAppearance(
    'main [aria-label=对话消息流]',
    '[aria-label=子代理状态]',
    'Summarizer',
  )
  assert.equal(mainSummarizerAvatar, summarizerAvatar, '自动汇总子代理在主对话和右栏使用相同图标')
  await capture('agents-completed')
  await evaluate(
    '(() => { const node = [...document.querySelectorAll("section[aria-label=已结束子代理] button")].find(button => button.textContent.includes("Summarizer")); node.click() })()',
  )
  await waitFor(
    () => evaluate('document.querySelector("#workspace-right-sidebar")?.textContent.includes("AUTO-CHILD-RAW-REPORT")'),
    '子代理详情仍显示完整报告',
  )
  assert.equal(
    await agentAppearance(panel, 'header', 'Summarizer'),
    summarizerAvatar,
    '自动汇总子代理详情保持同一任务标题和图标',
  )
  await capture('agent-summary-conversation')
  await clickText('返回列表', panel)
  await openTool(window, waitFor, '会话树')
  await waitFor(() => evaluate('Boolean(document.querySelector("[aria-label=会话节点列表]"))'), '汇总后的会话树')
  await clickText('全部', panel)
  const treeText = await evaluate('document.querySelector("[aria-label=会话节点列表]").textContent')
  for (const value of ['AUTO-CHILD-RAW-REPORT', '已保存的协作消息', 'pi-meme-collaboration'])
    assert.equal(treeText.includes(value), false, '会话树隐藏内部控制和报告节点')
  await clickText('仅用户', panel)
  assert.equal(
    await evaluate(
      '[...document.querySelectorAll("[aria-label=会话节点列表] [data-entry-id]")].filter(node => node.textContent.includes("collaboration-summary-smoke")).length',
    ),
    1,
    '树中只有用户实际输入的汇总任务',
  )
  assert.equal(
    await evaluate('document.querySelector("[aria-label=会话节点列表]").textContent.includes("已保存的协作消息")'),
    false,
    '仅用户视图无假的自动消息',
  )
  await capture('agent-summary-user-tree')
  await evaluate('document.querySelector("button[aria-label=收起右侧栏]").click()')

  await require('./plan-composer-smoke.cjs')(window, waitFor, directory, screenshots, {
    capture,
    countUsers: async () => userEntries(await fs.readFile(parentFile, 'utf8')).length,
  })
}
