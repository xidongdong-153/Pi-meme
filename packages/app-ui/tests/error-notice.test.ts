import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ErrorNotice } from '../src/error-notice'

function renderNotice(message: string) {
  return renderToStaticMarkup(createElement(ErrorNotice, { message, onOpenSettings: () => {}, onDismiss: () => {} }))
}

test('错误提示移除 Electron IPC 包装和重复 Error 前缀，保留实际原因', () => {
  for (const prefix of ['', 'Error: ']) {
    const html = renderNotice(
      `${prefix}Error invoking remote method 'pi:prompt': Error: Pi 操作失败：Error: 模拟编辑提交失败`,
    )
    assert.ok(html.includes('Pi 操作失败：模拟编辑提交失败'))
    assert.ok(!html.includes('Error invoking remote method'))
    assert.ok(!html.includes('Error:'))
    assert.ok(html.includes('关闭错误提示'))
    assert.ok(!html.includes('打开设置'))
  }
})

test('错误提示保留普通英文原因，CLI 路径错误仍提供设置入口', () => {
  assert.ok(renderNotice('Connection refused: localhost').includes('Connection refused: localhost'))
  const html = renderNotice("Error invoking remote method 'pi:prompt': Error: 找不到 Pi CLI 或 Node.js：/missing-pi")
  assert.ok(html.includes('找不到 Pi CLI 或 Node.js：/missing-pi'))
  assert.ok(html.includes('打开设置'))
})

test('扩展加载失败指向插件设置，不提示重发消息', () => {
  const html = renderNotice('Pi 进程已退出：Failed to load extension /tmp/broken.ts: 错误')
  assert.ok(html.includes('插件设置中检查加载状态'))
  assert.ok(html.includes('打开设置'))
  assert.ok(!html.includes('再次点击发送'))
})
