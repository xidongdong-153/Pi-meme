const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')

module.exports = async (window, waitFor, outputDirectory) => {
  const evaluate = (code) => window.webContents.executeJavaScript(code)
  const trigger = 'button[aria-label="选择模型与思考强度"]'
  const openModels = async () => {
    await evaluate(`document.querySelector('${trigger}').click()`)
    await waitFor(() => evaluate('Boolean(document.querySelector("[role=slider]"))'), '思考强度面板')
    await evaluate(`(() => {
      const button = [...document.querySelectorAll('[role=dialog] button')].find(node => node.textContent.includes('first') || node.textContent.includes('picker-18'));
      button.click();
    })()`)
    await waitFor(() => evaluate('Boolean(document.querySelector("[aria-label=可用模型]"))'), '模型列表')
  }
  const fill = async (value) => {
    await evaluate(
      `(() => { if (!document.querySelector('input[aria-label=搜索模型]')) document.querySelector('button[aria-label=搜索模型]')?.click() })()`,
    )
    await waitFor(() => evaluate(`Boolean(document.querySelector('input[aria-label=搜索模型]'))`), '模型搜索框')
    await evaluate(`(() => {
      const input = document.querySelector('input[aria-label="搜索模型"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
  }
  await waitFor(
    () => evaluate(`Boolean(document.querySelector('${trigger}') && !document.querySelector('${trigger}').disabled)`),
    '模型加载',
  )
  await openModels()
  const metrics = await evaluate(`(() => {
    const list = document.querySelector('[aria-label="可用模型"]') || document.querySelector('[data-radix-scroll-area-viewport]');
    return { height: list.clientHeight, content: list.scrollHeight };
  })()`)
  assert.ok(metrics.height > 0 && metrics.height < metrics.content, '长列表必须有可滚动的高度约束')
  await evaluate(`(() => {
    const list = document.querySelector('[aria-label="可用模型"]');
    list.scrollTop = list.scrollHeight;
  })()`)
  assert.equal(
    await evaluate(`(() => {
    const list = document.querySelector('[aria-label="可用模型"]');
    const item = [...list.querySelectorAll('button')].at(-1).getBoundingClientRect();
    const bounds = list.getBoundingClientRect();
    return item.top >= bounds.top && item.bottom <= bounds.bottom + 1;
  })()`),
    true,
  )
  await fs.writeFile(
    path.join(outputDirectory, 'model-picker-scroll.png'),
    (await window.webContents.capturePage()).toPNG(),
  )
  await evaluate(`document.querySelector('[aria-label="可用模型"] button:last-child').click()`)
  await waitFor(
    () => evaluate('window.piMemeClient.getSnapshot().then(snapshot => snapshot.state.model.id === "picker-18")'),
    '末项模型切换',
  )
  await evaluate(`document.querySelector('${trigger}').click()`)
  await openModels()
  await fill(' PICKER-18 ')
  await waitFor(
    () => evaluate('document.querySelectorAll("[aria-label=可用模型] button").length === 1'),
    '模型 ID 搜索',
  )
  await fill('不存在的模型')
  await waitFor(
    () => evaluate('document.querySelector("[role=status]")?.textContent.includes("没有匹配的模型")'),
    '搜索空状态',
  )
  await fill('picker-test')
  await waitFor(() => evaluate('document.querySelectorAll("[aria-label=可用模型] button").length === 18'), '服务商搜索')
  window.setMinimumSize(480, 360)
  window.setSize(600, 480)
  await waitFor(
    () =>
      evaluate(`(() => {
    const bounds = document.querySelector('[role=dialog]').getBoundingClientRect();
    return bounds.top >= 0 && bounds.bottom <= innerHeight;
  })()`),
    '小窗口边界',
  )
  await fs.writeFile(
    path.join(outputDirectory, 'model-picker-small.png'),
    (await window.webContents.capturePage()).toPNG(),
  )
}
