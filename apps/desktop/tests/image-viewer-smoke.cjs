const assert = require('node:assert/strict')

module.exports = async function imageViewerSmoke(window, waitFor, screenshots) {
  const { evaluate, pressKey, capture } = require('./desktop-test-helpers.cjs').desktopTestHelpers(
    window,
    waitFor,
    screenshots,
  )
  const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const trigger = '[role="combobox"][aria-label="图片缩放比例"]'
  const open = async () => {
    await pressKey('Enter', trigger)
    await waitFor(() => evaluate('Boolean(document.querySelector("[role=listbox]"))'), '图片缩放菜单')
  }
  const choose = async (text) => {
    await open()
    await evaluate(
      `Array.from(document.querySelectorAll('[role="option"]')).find(node => node.textContent === ${JSON.stringify(text)}).click()`,
    )
    await waitFor(
      () =>
        evaluate(
          `document.querySelector(${JSON.stringify(trigger)})?.getAttribute('aria-expanded') === 'false' && !document.querySelector('[role=listbox]') && document.activeElement === document.querySelector(${JSON.stringify(trigger)})`,
        ),
      '图片缩放菜单关闭',
    )
  }
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE9sAAAAASUVORK5CYII='
  for (let index = 0; index < 2; index++) {
    await evaluate(`(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([Uint8Array.from(atob(${JSON.stringify(png)}), char => char.charCodeAt(0))], 'preview.png', { type: 'image/png' }));
      document.querySelector('form[aria-label="消息输入"]').dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    })()`)
    await waitFor(
      () => evaluate(`document.querySelectorAll('[aria-label="已附加图片"] img').length === ${index + 1}`),
      '添加预览图片',
    )
  }
  await click('button[aria-label="预览第 1 张图片"]')
  await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(trigger)}))`), '图片缩放下拉')
  await choose('100%')
  await pressKey('ArrowRight', trigger)
  assert.equal(
    await evaluate(`Boolean(document.querySelector('img[alt="图片大图预览，第 1 张"]'))`),
    true,
    '缩放控件的方向键不切换图片',
  )
  await open()
  await pressKey('ArrowRight')
  assert.equal(
    await evaluate(`Boolean(document.querySelector('img[alt="图片大图预览，第 1 张"]'))`),
    true,
    '菜单内方向键不切换图片',
  )
  await capture('image-viewer-menu')
  await pressKey('Escape')
  await waitFor(
    () =>
      evaluate(
        `document.activeElement === document.querySelector(${JSON.stringify(trigger)}) && !document.querySelector('[role=listbox]')`,
      ),
    'Esc 只关闭菜单并还原焦点',
  )
  assert.equal(
    await evaluate(`Boolean(document.querySelector(${JSON.stringify(trigger)}))`),
    true,
    '关闭菜单保留图片预览',
  )
  await click('button[aria-label="放大图片"]')
  await waitFor(
    () => evaluate(`document.querySelector(${JSON.stringify(trigger)}).textContent === '125%'`),
    '按钮缩放同步',
  )
  await evaluate(
    'document.querySelector("[aria-label=图片预览区域]").dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }))',
  )
  await waitFor(
    () => evaluate(`document.querySelector(${JSON.stringify(trigger)}).textContent === '137.5%'`),
    '滚轮缩放保留非预设比例',
  )
  await choose('适应窗口')
  await capture('image-viewer-select')
  await pressKey('Escape', '[aria-label=图片预览区域]')
  await waitFor(() => evaluate(`!document.querySelector(${JSON.stringify(trigger)})`), '关闭图片预览')
  await waitFor(
    () => evaluate('document.activeElement?.getAttribute("aria-label") === "预览第 1 张图片"'),
    '关闭动画结束后还原附件焦点',
  )
  assert.equal(
    await evaluate('document.activeElement?.getAttribute("aria-label")'),
    '预览第 1 张图片',
    '关闭预览还原附件焦点',
  )
  for (let remaining = 1; remaining >= 0; remaining--) {
    await click('button[aria-label="移除图片"]')
    await waitFor(
      () => evaluate(`document.querySelectorAll('[aria-label="已附加图片"] img').length === ${remaining}`),
      '移除测试图片',
    )
  }
}
