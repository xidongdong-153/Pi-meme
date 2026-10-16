import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, vi } from 'vitest'
import { createServer as createNetServer } from 'node:net'
import { startHostServer } from '@pi-meme/host/server'
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
      `/@fs${path.resolve(root, '../../packages/app-ui/src/session/use-app-session.ts')}`,
    )
    assert.ok(app)
    const chatUrl = app.code.match(/from\s*["']([^"']*use-chat-session\.ts[^"']*)["']/)?.[1]
    assert.ok(chatUrl, '聊天 Hook 应引用 workspace 源文件，而不是预打包缓存')
    assert.ok(!chatUrl.includes('/.vite/'))
    assert.ok(!chatUrl.includes('/node_modules/'), 'workspace 软链接应解析到真实源码路径')
    const chat = await server.transformRequest(chatUrl)
    assert.ok(chat)
    assert.match(chat.code, /bridge\.prompt\(sessionKey, message, images, skills, \{\s*mode: messageMode\s*\}\)/)
    assert.match(chat.code, /const sendMode = running \? ["']followUp["'] : ["']prompt["']/)
    assert.match(chat.code, /bridge\.steerQueueInput|bridge\[action\]\(key, id\)/)
    assert.match(chat.code, /bridge\.followUp\(sessionKey, message, images, skills, \{\s*mode: messageMode\s*\}\)/)
  } finally {
    await server.close()
    await rm(cacheDir, { recursive: true, force: true })
  }
})

test('Desktop 开发代理与 Host 使用同一端口，忽略 Web 覆盖地址并等待 Host 就绪', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-vite-shared-'))
  const listener = createNetServer()
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
  const address = listener.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>((resolve) => listener.close(() => resolve()))
  vi.stubEnv('PI_MEME_PORT', String(address.port))
  vi.stubEnv('PI_MEME_HOST_URL', 'http://127.0.0.1:9')
  const root = fileURLToPath(new URL('..', import.meta.url))
  let vite: Awaited<ReturnType<typeof createServer>> | undefined
  let host: Awaited<ReturnType<typeof startHostServer>> | undefined
  try {
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
    const target = loaded.config.server?.proxy?.['/api']
    assert.ok(typeof target === 'object')
    assert.equal(target.target, `http://127.0.0.1:${address.port}`)
    vite = await createServer({
      ...loaded.config,
      configFile: false,
      cacheDir: path.join(directory, 'cache'),
      server: { ...loaded.config.server, port: 0, strictPort: false, watch: null },
    })
    await vite.listen()
    const viteAddress = vite.httpServer!.address()
    assert.ok(viteAddress && typeof viteAddress !== 'string')
    const origin = `http://127.0.0.1:${viteAddress.port}`
    const authentication = fetch(`${origin}/api/auth`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: '{}',
    })
    host = await startHostServer({
      dataRoot: path.join(directory, 'data'),
      port: address.port,
      testCredentials: true,
      localAutoLogin: true,
      owner: 'desktop',
    })
    const response = await authentication
    assert.equal(response.status, 200)
    assert.equal(((await response.json()) as { hostId: string }).hostId, host.host.hostId)
    assert.match(response.headers.get('set-cookie')!, /HttpOnly/)
  } finally {
    await vite?.close()
    await host?.dispose()
    vi.unstubAllEnvs()
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})
