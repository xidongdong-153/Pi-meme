import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ComposerAttachments } from '../src/ui/composer/composer-attachments'
import { AttachmentPreview } from '../src/ui/content/attachment-preview'
import { imageSource, nextImageZoom } from '../src/ui/content/image-viewer'

const images = [
  { id: 'first', type: 'image' as const, mimeType: 'image/png', data: 'YWJj' },
  { id: 'second', type: 'image' as const, mimeType: 'image/jpeg', data: 'ZGVm' },
]

test('输入框和消息附件都提供逐张预览入口，并保留正确图片源', () => {
  for (const element of [
    createElement(ComposerAttachments, { attachments: images, onRemoveImage: () => {} }),
    createElement(AttachmentPreview, { images }),
  ]) {
    const html = renderToStaticMarkup(element)
    assert.match(html, /aria-label="预览第 1 张图片"/)
    assert.match(html, /aria-label="预览第 2 张图片"/)
    assert.match(html, /src="data:image\/png;base64,YWJj"/)
    assert.match(html, /src="data:image\/jpeg;base64,ZGVm"/)
  }
})

test('输入附件的移除入口默认透明，悬停和键盘聚焦均可显示', () => {
  const html = renderToStaticMarkup(
    createElement(ComposerAttachments, { attachments: images, onRemoveImage: () => {} }),
  )
  const removeButtons = html.match(/<button[^>]*aria-label="移除图片"[^>]*>/g) ?? []
  assert.equal(removeButtons.length, 2)
  for (const button of removeButtons) {
    assert.match(button, /opacity-0/)
    assert.match(button, /group-hover:opacity-100/)
    assert.match(button, /group-focus-within:opacity-100/)
    assert.doesNotMatch(button, /tabindex="-1"|hidden/)
  }
})

test('预览保留现有 data URL 和远程 URL，不重复拼接 base64 前缀', () => {
  for (const data of ['data:image/png;base64,YWJj', 'https://example.test/image.png']) {
    assert.equal(imageSource({ type: 'image', mimeType: 'image/png', data }), data)
  }
})

test('超长截图适应窗口后，缩小按钮和滚轮不会反向放大', () => {
  const fitted = 3.25
  assert.equal(nextImageZoom(fitted, 1 / 1.25), 2.6)
  assert.equal(nextImageZoom(fitted, 1 / 1.1), 2.95)
  assert.equal(nextImageZoom(0.005, 1 / 1.25), 0.005)
  assert.equal(nextImageZoom(0.01, 1 / 1.1), 0.01)
  assert.equal(nextImageZoom(499, 1.25), 500)
})
