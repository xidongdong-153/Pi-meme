const fs = require('node:fs/promises')
const path = require('node:path')
const { app } = require('electron')

async function within(promise, milliseconds, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`桌面验收等待超时：${label}`)), milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function desktopTestHelpers(window, waitFor, screenshots) {
  const evaluate = (code) =>
    within(window.webContents.executeJavaScript(code), 10000, `执行脚本：${code}`).catch((cause) => {
      throw new Error(`桌面验收脚本执行失败：${code}`, { cause })
    })
  const focusWindow = async () => {
    if (!window.isFocused() || !window.webContents.isFocused() || !(await evaluate('document.hasFocus()'))) {
      if (process.platform === 'darwin') app.focus({ steal: true })
      window.show()
      window.focus()
      window.webContents.focus()
    }
    await waitFor(
      async () => window.isFocused() && window.webContents.isFocused() && (await evaluate('document.hasFocus()')),
      '窗口、WebContents 和文档获得焦点',
    )
  }
  const pressKey = async (key, selector, modifiers = []) => {
    await focusWindow()
    if (selector) {
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`)
      await waitFor(
        () => evaluate(`document.activeElement === document.querySelector(${JSON.stringify(selector)})`),
        `按键目标获得焦点：${selector}`,
      )
    }
    const keyCode =
      {
        Enter: 'Return',
        ' ': 'Space',
        ArrowUp: 'Up',
        ArrowDown: 'Down',
        ArrowLeft: 'Left',
        ArrowRight: 'Right',
      }[key] ?? key
    await evaluate(
      `window.desktopSmokeKeyDown = null; document.addEventListener('keydown', event => { window.desktopSmokeKeyDown = event }, { once: true, capture: true })`,
    )
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    try {
      await waitFor(() => evaluate('Boolean(window.desktopSmokeKeyDown)'), `页面收到原生按键：${key}`)
      const receivedKey = await evaluate('window.desktopSmokeKeyDown.key')
      if (receivedKey.toLowerCase() !== key.toLowerCase())
        throw new Error(`原生按键不匹配：期望 ${key}，页面收到 ${receivedKey}`)
      if (
        (key === 'Enter' || key.length === 1) &&
        modifiers.length === 0 &&
        !(await evaluate('window.desktopSmokeKeyDown.defaultPrevented')) &&
        (await evaluate(`(() => {
          const target = window.desktopSmokeKeyDown.target;
          return target === document.activeElement && (target.matches('button,input,textarea') || target.isContentEditable);
        })()`))
      )
        window.webContents.sendInputEvent({ type: 'char', keyCode: key === 'Enter' ? '\r' : key, modifiers })
    } finally {
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    }
  }
  const capture = async (name) => {
    await within(
      (async () => {
        await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
        const image = await window.webContents.capturePage()
        await fs.writeFile(path.join(screenshots, `${name}.png`), image.toPNG())
      })(),
      5000,
      `保存截图：${name}`,
    )
  }
  const diagnose = async () => ({
    nativeFocus: window.isFocused(),
    webContentsFocus: window.webContents.isFocused(),
    page: await evaluate(`({
      focused: document.hasFocus(),
      key: window.desktopSmokeKeyDown && {key:window.desktopSmokeKeyDown.key,code:window.desktopSmokeKeyDown.code,prevented:window.desktopSmokeKeyDown.defaultPrevented},
      active: document.activeElement?.outerHTML.slice(0, 600),
      layers: [...document.querySelectorAll('[role="dialog"], [role="menu"], [role="listbox"]')].map(node => ({role:node.getAttribute('role'),state:node.dataset.state,visible:node.checkVisibility()})),
      text: document.body.innerText.slice(0, 3000),
    })`),
  })
  return { evaluate, focusWindow, pressKey, capture, diagnose }
}

module.exports = { within, desktopTestHelpers }
