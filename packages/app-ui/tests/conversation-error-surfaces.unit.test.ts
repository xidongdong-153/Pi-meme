import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ErrorBoundary } from '@pi-meme/ui/components/error-boundary'
import { ErrorLine } from '@pi-meme/ui/components/error-line'
import { ExtensionNotices } from '@pi-meme/interaction/ui/extension-notices'
import { PluginToolCardProvider } from '@pi-meme/ui/components/plugin-tool-card'
import { ToolActivityRow } from '@pi-meme/chat/ui/conversation/tool-activity-row'

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

test('扩展错误保留原因和顺序，普通通知保留正文', () => {
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
  assert.doesNotMatch(error, /旧错误/)
  assert.ok(error.indexOf('新错误') < error.indexOf('扩展失败'))
  const info = renderToStaticMarkup(
    createElement(ExtensionNotices, {
      notices: [{ id: 2, type: 'info', message: '任务信息' }],
      onDismiss: () => {},
    }),
  )
  assert.match(info, /任务信息/)
})

test('会话渲染异常使用摘要行并保留重试，其他页面保留原来的异常处理', () => {
  const boundary = new ErrorBoundary({ children: null, inline: true, fallbackTitle: '当前会话内容渲染失败' })
  boundary.state = { hasError: true, error: new Error('组件异常\n原始堆栈') }
  const html = renderToStaticMarkup(boundary.render())
  assert.match(html, /当前会话内容渲染失败/)
  assert.match(html, /重试加载/)
  assert.match(html, /原始堆栈/)
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
  assert.doesNotMatch(html, /插件错误卡片/)
})
