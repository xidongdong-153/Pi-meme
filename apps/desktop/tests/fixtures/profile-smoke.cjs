const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { app } = require('electron')

module.exports = async function profileSmoke(window, waitFor, directory, screenshots) {
  const evaluate = (code) => window.webContents.executeJavaScript(code)
  const clickText = (text) =>
    evaluate(
      `Array.from(document.querySelectorAll('button')).find(node => node.textContent.trim() === ${JSON.stringify(text)}).click()`,
    )
  const capture = async (name) => {
    await evaluate(
      `new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('截图渲染等待超时')), 10000); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve() })) })`,
    )
    await fs.writeFile(path.join(screenshots, `${name}.png`), (await window.webContents.capturePage()).toPNG())
  }
  const refreshed = async () => {
    await evaluate(`document.querySelector('[aria-label="刷新 Token 统计"]').click()`)
    await waitFor(
      () => evaluate(`document.querySelector('[aria-label="个人资料统计"]')?.getAttribute('aria-busy') === 'false'`),
      '用量刷新完成',
    )
  }
  const sessions = path.join(directory, 'sessions')
  const backup = path.join(directory, 'profile-sessions-backup')
  let moved = false
  try {
    try {
      await fs.rename(sessions, backup)
      moved = true
    } catch (cause) {
      if (cause.code !== 'ENOENT') throw cause
    }
    await clickText('用量')
    await waitFor(
      () => evaluate(`document.querySelector('[aria-label="个人资料统计"]')?.getAttribute('aria-busy') === 'false'`),
      '个人资料空状态',
    )
    assert.equal(
      await evaluate(`document.querySelector('dl[aria-label="历史用量统计"]').querySelectorAll('dt').length`),
      5,
    )
    assert.equal(await evaluate(`document.querySelector('dl dd').textContent`), '0')
    assert.equal(await evaluate(`document.body.textContent.includes('近 12 个月暂无 Token 活动')`), true)
    assert.equal(await evaluate(`document.body.textContent.includes('精选作品')`), false)
    await capture('profile-empty')

    const now = new Date()
    const header = { type: 'session', version: 3, id: 'profile-fixture', cwd: directory, timestamp: now.toISOString() }
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9)
    const user = {
      type: 'message',
      id: 'profile-user',
      parentId: null,
      timestamp: start.toISOString(),
      message: { role: 'user', content: '用量验收', timestamp: start.getTime() },
    }
    const entries = [header, user]
    let expected = 0
    for (let month = 0; month < 12; month++) {
      for (const day of [2, 8, 14, 20, 26]) {
        const at = new Date(now.getFullYear(), now.getMonth() - month, day, 10, 30)
        if (at > now) continue
        const totalTokens = (12 - month) * day * 10000
        expected += totalTokens
        entries.push({
          type: 'message',
          id: `profile-${month}-${day}`,
          parentId: 'profile-user',
          timestamp: at.toISOString(),
          message: {
            role: 'assistant',
            content: [],
            timestamp: at.getTime(),
            stopReason: 'stop',
            usage: { totalTokens },
          },
        })
      }
    }
    const end = new Date(start.getTime() + 90 * 60 * 1000)
    expected += 100
    entries.push({
      type: 'message',
      id: 'profile-end',
      parentId: 'profile-user',
      timestamp: end.toISOString(),
      message: {
        role: 'assistant',
        content: [],
        timestamp: end.getTime(),
        stopReason: 'stop',
        usage: { totalTokens: 100 },
      },
    })
    const project = require('./runtime-paths.cjs').sessionDirectory(directory, directory)
    await fs.mkdir(project, { recursive: true })
    const file = path.join(project, 'profile.jsonl')
    await fs.writeFile(file, entries.map((entry) => JSON.stringify(entry)).join('\n'))
    await refreshed()
    const snapshot = await evaluate('window.piMemeClient.getUsageStats()')
    assert.equal(snapshot.totalTokens, expected)
    assert.equal(snapshot.longestTaskMs, 90 * 60 * 1000)
    assert.equal(await evaluate(`document.querySelectorAll('dl dd')[2].textContent`), '1 小时 30 分钟')
    const firstWeekday = await evaluate(
      `(() => { const cells = document.querySelector('[aria-label="每日 Token 热力图"]'); return cells.querySelector('button').getAttribute('aria-label') })()`,
    )
    assert.match(firstWeekday, /Token/)
    app.focus({ steal: true })
    window.focus()
    window.webContents.focus()
    await waitFor(() => evaluate('document.hasFocus()'), '验收窗口获得焦点')
    await evaluate(`document.querySelector('[aria-label="每日 Token 热力图"] button').focus()`)
    assert.equal(await evaluate(`document.activeElement?.closest('[aria-label="每日 Token 热力图"]') !== null`), true)
    await waitFor(() => evaluate(`Boolean(document.querySelector('[role="tooltip"]'))`), '键盘聚焦用量提示')
    await capture('profile-dark')
    await clickText('每周')
    assert.equal(await evaluate(`Boolean(document.querySelector('[aria-label="每周 Token 柱状图"]'))`), true)
    await capture('profile-week')
    await clickText('每月')
    assert.equal(
      await evaluate(`document.querySelector('[aria-label="每月 Token 柱状图"]').querySelectorAll('button').length`),
      12,
    )
    await capture('profile-month')
    await clickText('每天')
    await clickText('外观')
    await evaluate(`document.querySelector('[aria-label="浅色模式"]').click()`)
    await waitFor(() => evaluate(`document.documentElement.dataset.appearance === 'light'`), '个人资料浅色主题')
    await clickText('用量')
    await waitFor(
      () => evaluate(`document.querySelector('[aria-label="个人资料统计"]')?.getAttribute('aria-busy') === 'false'`),
      '重新进入个人资料',
    )
    await capture('profile-light')
    window.setSize(720, 500)
    await capture('profile-small')
    assert.equal(
      await evaluate(
        `document.querySelector('#settings-content').scrollWidth <= document.querySelector('#settings-content').clientWidth`,
      ),
      true,
    )
    assert.equal(
      await evaluate(
        `(() => { const chart = document.querySelector('[aria-label="Token 活动图，可横向滚动"]'); return chart.scrollWidth > chart.clientWidth })()`,
      ),
      true,
    )
    window.setSize(1100, 760)

    await fs.appendFile(file, '\n{invalid')
    await refreshed()
    assert.equal(await evaluate(`document.body.textContent.includes('统计可能不完整')`), true)
    await fs.rm(sessions, { recursive: true })
    await fs.writeFile(sessions, '不是目录')
    await refreshed()
    assert.equal(
      await evaluate(
        `document.querySelector('[aria-label="个人资料统计"] [role="alert"]').textContent.includes('无法加载 Token 统计')`,
      ),
      true,
    )
    await capture('profile-error')
    await fs.rm(sessions)
    await evaluate(`Array.from(document.querySelectorAll('button')).find(node => node.textContent === '重试').click()`)
    await waitFor(
      () =>
        evaluate(
          `!document.querySelector('[aria-label="个人资料统计"] [role="alert"]') && document.querySelector('dl dd').textContent === '0'`,
        ),
      '错误重试恢复',
    )
    await clickText('外观')
    await evaluate(`document.querySelector('[aria-label="深色模式"]').click()`)
    await waitFor(() => evaluate(`document.documentElement.dataset.appearance === 'dark'`), '恢复深色主题')
  } finally {
    window.setSize(1100, 760)
    await fs.rm(sessions, { recursive: true, force: true })
    if (moved) await fs.rename(backup, sessions)
  }
}
