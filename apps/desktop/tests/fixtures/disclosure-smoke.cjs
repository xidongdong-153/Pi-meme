const assert = require('node:assert/strict')

module.exports = async (window, waitFor, label) => {
  const { evaluate, pressKey, focusWindow } = require('./desktop-test-helpers.cjs').desktopTestHelpers(window, waitFor)
  await focusWindow()
  const drafts = await evaluate(`[...document.querySelectorAll('input,textarea')].map(node => node.value)`)
  const selector = JSON.stringify(`button[aria-label="${label}"]`)
  const originalMotion = await evaluate(`document.documentElement.getAttribute('data-reduced-motion')`)
  try {
    await evaluate(`document.documentElement.dataset.reducedMotion = 'false'`)
    const initial = await evaluate(`(() => {
      const trigger = document.querySelector(${selector});
      const region = document.getElementById(trigger.getAttribute('aria-controls'));
      return { expanded: trigger.getAttribute('aria-expanded'), inert: region.inert, height: region.getBoundingClientRect().height };
    })()`)
    assert.equal(initial.expanded, 'false')
    assert.equal(initial.inert, true)
    assert.ok(initial.height < 1, '收起区域不占用内容高度')
    const heights = await evaluate(`(async () => {
      const trigger = document.querySelector(${selector});
      const region = document.getElementById(trigger.getAttribute('aria-controls'));
      trigger.click();
      const heights = [];
      const started = performance.now();
      while (performance.now() - started < 280) {
        await new Promise(requestAnimationFrame);
        heights.push(region.getBoundingClientRect().height);
      }
      return heights;
    })()`)
    const finalHeight = heights.at(-1)
    assert.ok(finalHeight > 1, `展开后显示内容；采样高度：${JSON.stringify(heights)}`)
    assert.ok(
      heights.some((height) => height > 1 && height < finalHeight - 1),
      '展开经过中间高度，实际执行动效',
    )
    await evaluate(`document.querySelector(${selector}).click()`)
    await waitFor(
      () =>
        evaluate(`(() => {
          const trigger = document.querySelector(${selector});
          return document.getElementById(trigger.getAttribute('aria-controls')).getBoundingClientRect().height < 1;
        })()`),
      '折叠动画完成',
    )
    assert.equal(
      await evaluate(`(() => {
        const trigger = document.querySelector(${selector});
        const region = document.getElementById(trigger.getAttribute('aria-controls'));
        trigger.focus();
        region.querySelector('input,button,textarea').focus();
        return region.inert && document.activeElement === trigger;
      })()`),
      true,
      '隐藏内容保留在 DOM 中，但不能获得键盘焦点',
    )
    for (const [key, expanded] of [
      ['Enter', true],
      [' ', false],
      [' ', true],
      ['Enter', false],
      ['Enter', true],
    ]) {
      await pressKey(key, `button[aria-label="${label}"]`)
      await waitFor(
        () => evaluate(`document.querySelector(${selector}).getAttribute('aria-expanded') === '${expanded}'`),
        `键盘 ${key === ' ' ? 'Space' : key} ${expanded ? '展开' : '收起'}折叠区域`,
      )
      assert.deepEqual(
        await evaluate(`[...document.querySelectorAll('input,textarea')].map(node => node.value)`),
        drafts,
        '折叠切换保留表单草稿',
      )
    }
    await evaluate(`document.documentElement.dataset.reducedMotion = 'true'`)
    assert.equal(
      await evaluate(
        `getComputedStyle(document.getElementById(document.querySelector(${selector}).getAttribute('aria-controls'))).transitionDuration`,
      ),
      '0s',
      '减少动态效果关闭过渡',
    )
    await evaluate(`document.querySelector(${selector}).click()`)
  } finally {
    await evaluate(
      originalMotion === null
        ? `document.documentElement.removeAttribute('data-reduced-motion')`
        : `document.documentElement.setAttribute('data-reduced-motion',${JSON.stringify(originalMotion)})`,
    )
  }
}
