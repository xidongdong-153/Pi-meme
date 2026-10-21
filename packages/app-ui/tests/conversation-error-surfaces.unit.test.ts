import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ErrorBoundary } from '@pi-meme/ui/components/error-boundary'
import { ErrorLine } from '@pi-meme/ui/components/error-line'
import { emptyChat } from '@pi-meme/chat/ui/model/state'
import { ExtensionNotices } from '@pi-meme/interaction/ui/extension-notices'
import { PluginToolCardProvider } from '@pi-meme/ui/components/plugin-tool-card'
import { ToolActivityRow } from '@pi-meme/chat/ui/conversation/tool-activity-row'
import { SystemErrorStack } from '../src/layout/error-notice'
import { WorkspaceContent } from '../src/layout/workspace-content'

test('摘要独立于长原因和操作，重试次数保持在不可截断的同行区域', () => {
  const html = renderToStaticMarkup(
    createElement(ErrorLine, {
      message: 'network error\n路径：/very/long/path\n请求失败',
      suffix: '重试中（2/7）',
      actions: createElement('button', null, '重试'),
      onDismiss: () => {},
    }),
  )
  assert.match(html, /role="status"/)
  assert.match(html, /shrink-0 whitespace-nowrap text-destructive">重试中（2\/7）/)
  assert.match(html, /路径：\/very\/long\/path/)
  assert.match(html, /关闭错误提示/)
  assert.doesNotMatch(html, /border-destructive|bg-destructive|<details[^>]* open/)
  assert.equal(renderToStaticMarkup(createElement(ErrorLine, { message: ' \n ' })), '')
})

test('服务商 JSON 错误只在摘要显示原因，完整响应留在折叠详情', () => {
  for (const payload of [{ message: 'network error\n请求超时' }, { error: { message: 'network error\n请求超时' } }]) {
    const message = `503: ${JSON.stringify(payload)}`
    const html = renderToStaticMarkup(createElement(ErrorLine, { message, suffix: '重试中（1/3）' }))
    const summary = html.match(/<summary[\s\S]*?<\/summary>/)?.[0] ?? ''
    assert.match(summary, /network error/)
    assert.doesNotMatch(summary, /503|message|请求超时/)
    assert.match(html, /503/)
    assert.match(html, /请求超时/)
  }
})

test('扩展错误使用系统错误卡片，普通通知仍可使用浮层', () => {
  const error = renderToStaticMarkup(
    createElement(ExtensionNotices, {
      notices: [
        { id: 1, type: 'error', message: '旧错误' },
        { id: 2, type: 'error', message: '扩展失败\n事件：message_end' },
        { id: 3, type: 'error', message: '新错误' },
      ],
      onDismiss: () => {},
    }),
  )
  assert.match(error, /data-system-error/)
  assert.match(error, /这次操作没有完成/)
  assert.match(error, /事件：message_end/)
  assert.match(error, /border-border/)
  assert.match(error, /bg-card/)
  assert.match(error, /fixed top-16 right-4/)
  assert.match(error, /slide-in-from-right-4/)
  assert.doesNotMatch(error, /data-error-line|旧错误|border-destructive|bg-destructive/)
  assert.ok(error.indexOf('新错误') < error.indexOf('扩展失败'))
  const info = renderToStaticMarkup(
    createElement(ExtensionNotices, {
      notices: [{ id: 2, type: 'info', message: '任务信息' }],
      onDismiss: () => {},
    }),
  )
  assert.match(info, /fixed/)
})

function renderWorkspace(chat: typeof emptyChat) {
  return renderToStaticMarkup(
    createElement(WorkspaceContent, {
      chat,
      connection: { generation: 1, cwd: '/repo', status: 'ready' },
      ready: true,
      hasConnected: true,
      composer: createElement('div', { id: 'composer-slot' }),
      conversation: createElement('div', { id: 'conversation-slot' }),
      canEditMessages: false,
      onEditMessage: () => {},
      onForkReply: () => {},
      onCopyError: () => {},
      onSettings: () => {},
      notice: createElement('div', { id: 'notice-slot' }),
      children: null,
    }),
  )
}

test('系统错误使用右上角 Toast，不进入输入区', () => {
  const html = renderToStaticMarkup(
    createElement(SystemErrorStack, {
      items: [{ id: 'new', message: '无法读取插件列表', onOpenSettings: () => {}, onDismiss: () => {} }],
    }),
  )
  assert.match(html, /fixed top-16 right-4/)
  assert.match(html, /slide-in-from-right-4/)
  assert.match(html, /这次操作没有完成/)
  const active = renderWorkspace({ ...emptyChat, running: true })
  const column = active.slice(active.indexOf('chat-content-column'), active.indexOf('composer-slot'))
  assert.equal(column.includes('notice-slot'), false)
  assert.ok(active.indexOf('notice-slot') < active.indexOf('conversation-slot'))
})

test('会话渲染异常使用摘要行并保留重试，其他页面保留原来的异常处理', () => {
  const boundary = new ErrorBoundary({ children: null, inline: true, fallbackTitle: '当前会话内容渲染失败' })
  boundary.state = { hasError: true, error: new Error('组件异常\n原始堆栈') }
  const html = renderToStaticMarkup(boundary.render())
  assert.match(html, /当前会话内容渲染失败/)
  assert.match(html, /重试加载/)
  assert.match(html, /原始堆栈/)
  assert.doesNotMatch(html, /bg-destructive|border-destructive|lucide-circle-alert|justify-center/)
  const page = new ErrorBoundary({ children: null })
  page.state = boundary.state
  assert.match(renderToStaticMarkup(page.render()), /界面渲染遇到错误/)
})

test('失败工具使用通用折叠原因，不再追加插件自定义错误卡片', () => {
  const html = renderToStaticMarkup(
    createElement(PluginToolCardProvider, {
      render: () => createElement('div', { className: 'border-destructive bg-destructive' }, '插件错误卡片'),
      children: createElement(ToolActivityRow, {
        item: { id: 'plugin-tool', name: 'plugin-tool', status: 'error', result: '真实工具原因' },
        open: false,
        onToggle: () => {},
        isLive: false,
      }),
    }),
  )
  assert.match(html, /真实工具原因/)
  assert.doesNotMatch(html, /插件错误卡片|border-destructive|bg-destructive/)
})
