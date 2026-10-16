import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SettingsPage } from '../src/settings/settings-page'

test('个人导航以常规开头，打开设置时停在常规', () => {
  const html = renderToStaticMarkup(
    createElement(SettingsPage, {
      dirty: false,
      saving: false,
      onDiscard: () => {},
      onDismiss: () => {},
      renderContent: () => null,
    }),
  )
  const personal = html.slice(html.indexOf('>个人<'), html.indexOf('>Agent<'))
  const labels = [...personal.matchAll(/<span class="truncate">([^<]+)<\/span>/g)].map((match) => match[1])
  assert.deepEqual(labels, ['常规', '外观', '用量'])
  const current = personal.slice(personal.indexOf('aria-current="page"'))
  assert.match(current, /<span class="truncate">常规<\/span>/)
  assert.doesNotMatch(html, />偏好</)
  assert.match(html, /sr-only">返回聊天</)
  assert.match(html, /class="[^"]*\bpl-3\b/)
  assert.doesNotMatch(html, /\bpl-24\b/)
})

test('Desktop 设置返回键让出交通灯，Web 靠左', () => {
  const desktop = renderToStaticMarkup(
    createElement(SettingsPage, {
      dirty: false,
      saving: false,
      nativeWindow: true,
      onDiscard: () => {},
      onDismiss: () => {},
      renderContent: () => null,
    }),
  )
  assert.match(desktop, /\bpl-24\b/)
  assert.doesNotMatch(desktop, /\bpl-3\b/)
})
