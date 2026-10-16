import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  STARTUP_SPLASH_EXIT_MS,
  STARTUP_SPLASH_MIN_MS,
  StartupSplash,
  startupSplashSchedule,
} from '../src/shell/startup-splash'

test('启动画面只淡入图标和名称', () => {
  const html = renderToStaticMarkup(createElement(StartupSplash))
  assert.match(html, /data-testid="startup-splash"/)
  assert.match(html, /role="status"/)
  assert.match(html, /aria-busy="true"/)
  assert.match(html, /brand-mark/)
  assert.match(html, /startup-splash-name/)
  assert.match(html, />pi-meme</)
  assert.match(html, /正在启动 pi-meme/)
  assert.doesNotMatch(html, /本地 AI 编程助手|startup-splash-bar|startup-splash-track|is-exiting/)
})

test('退出阶段停止忙碌并加上淡出标记', () => {
  const html = renderToStaticMarkup(createElement(StartupSplash, { exiting: true }))
  assert.match(html, /is-exiting/)
  assert.match(html, /aria-busy="false"/)
})

test('画面停留至少一段可见时间，减少动效时立即结束', () => {
  assert.deepEqual(startupSplashSchedule(0, false), { waitMs: STARTUP_SPLASH_MIN_MS, exitMs: STARTUP_SPLASH_EXIT_MS })
  assert.deepEqual(startupSplashSchedule(100, false), { waitMs: 320, exitMs: STARTUP_SPLASH_EXIT_MS })
  assert.deepEqual(startupSplashSchedule(STARTUP_SPLASH_MIN_MS + 80, false), {
    waitMs: 0,
    exitMs: STARTUP_SPLASH_EXIT_MS,
  })
  assert.deepEqual(startupSplashSchedule(0, true), { waitMs: 0, exitMs: 0 })
})
