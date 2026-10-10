import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createServer, loadConfigFromFile, mergeConfig } from 'vite'

test('开发模式直接加载 workspace 聊天源码，发送时保留会话标识', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'pi-desktop-vite-'))
  const loaded = await loadConfigFromFile(
    {
      command: 'serve',
      mode: 'development',
      root,
      forgeConfig: { build: [], renderer: [] },
      forgeConfigSelf: { name: 'main_window', config: 'vite.renderer.config.mts' },
    },
    path.join(root, 'vite.renderer.config.mts'),
  )
  assert.ok(loaded)
  const config = mergeConfig({ resolve: { preserveSymlinks: true }, base: './' }, loaded.config)
  const server = await createServer({
    ...config,
    root: config.root,
    configFile: false,
    cacheDir,
    server: { middlewareMode: true, watch: null },
  })
  try {
    const app = await server.transformRequest(
      `/@fs${path.resolve(root, '../../packages/app-ui/src/use-app-session.ts')}`,
    )
    assert.ok(app)
    const chatUrl = app.code.match(/from\s*["']([^"']*use-chat-session\.ts[^"']*)["']/)?.[1]
    assert.ok(chatUrl, '聊天 Hook 应引用 workspace 源文件，而不是预打包缓存')
    assert.ok(!chatUrl.includes('/.vite/'))
    assert.ok(!chatUrl.includes('/node_modules/'), 'workspace 软链接应解析到真实源码路径')
    const chat = await server.transformRequest(chatUrl)
    assert.ok(chat)
    assert.match(chat.code, /bridge\.prompt\(sessionKey, message, images, skills\)/)
    assert.match(chat.code, /bridge\.steer\(sessionKey, message, images, skills\)/)
    assert.match(chat.code, /bridge\.followUp\(sessionKey, message, images, skills\)/)
  } finally {
    await server.close()
    await rm(cacheDir, { recursive: true, force: true })
  }
})
