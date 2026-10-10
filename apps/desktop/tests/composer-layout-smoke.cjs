const assert = require('node:assert/strict')

module.exports = async (window, capture) => {
  const evaluate = (code) => window.webContents.executeJavaScript(code)
  const original = await evaluate(`(() => {
    const form = document.querySelector('form[aria-label="消息输入"]');
    const model = form.querySelector('[aria-label="选择模型与思考强度"] span');
    const saved = { style: form.getAttribute('style'), model: model?.textContent };
    form.style.transition = 'none';
    if (model) model.textContent = 'Gemini 3.8 Flash High (CLI Provider With A Very Long Name)';
    return saved;
  })()`)
  try {
    for (const width of [620, 420, 320]) {
      await evaluate(`document.querySelector('form[aria-label="消息输入"]').style.width = '${width}px'`)
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      const metrics = await evaluate(`(() => {
        const form = document.querySelector('form[aria-label="消息输入"]');
        const buttons = [...form.querySelectorAll('button')].filter(node => node.getBoundingClientRect().width > 0);
        const bounds = form.getBoundingClientRect();
        const label = node => node.getAttribute('aria-label') || node.textContent.trim();
        return {
          width: form.clientWidth,
          content: form.scrollWidth,
          wrapped: buttons.filter(node => /^(插话|排队|逐项插入|整批插入|逐项执行|整批执行)$/.test(node.textContent.trim())).filter(node => {
            const range = document.createRange();
            range.selectNodeContents(node);
            return new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size > 1;
          }).map(node => node.textContent.trim()),
          squeezed: buttons.filter(node => node.scrollWidth > node.clientWidth + 1).map(label),
          outside: buttons.filter(node => {
            const rect = node.getBoundingClientRect();
            return rect.left < bounds.left || rect.right > bounds.right + 1;
          }).map(label),
          overlapping: buttons.flatMap((node, index) => {
            const rect = node.getBoundingClientRect();
            return buttons.slice(index + 1).filter(other => {
              const target = other.getBoundingClientRect();
              return Math.min(rect.right, target.right) - Math.max(rect.left, target.left) > 1 &&
                Math.min(rect.bottom, target.bottom) - Math.max(rect.top, target.top) > 1;
            }).map(other => [label(node), label(other)]);
          }),
        };
      })()`)
      await capture(`composer-layout-${width}`)
      assert.ok(metrics.width <= width, `${width}px 输入框必须保持指定宽度`)
      assert.deepEqual(metrics.wrapped, [], `${width}px 输入框的模式标签不能换行`)
      assert.deepEqual(metrics.squeezed, [], `${width}px 输入框的控件不能被压窄`)
      assert.deepEqual(metrics.outside, [], `${width}px 输入框的控件不能超出边界`)
      assert.deepEqual(metrics.overlapping, [], `${width}px 输入框的控件不能重叠`)
      assert.ok(metrics.content <= metrics.width + 1, `${width}px 输入框不能横向溢出`)
    }
  } finally {
    await evaluate(`(() => {
      const form = document.querySelector('form[aria-label="消息输入"]');
      const saved = ${JSON.stringify(original)};
      if (saved.style === null) form.removeAttribute('style');
      else form.setAttribute('style', saved.style);
      const model = form.querySelector('[aria-label="选择模型与思考强度"] span');
      if (model && saved.model !== undefined) model.textContent = saved.model;
    })()`)
  }
}
