import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test, vi } from 'vitest'
import { createServer as createNetServer } from 'node:net'
import { startHostServer } from '@pi-meme/host/server'
import { build, createServer, loadConfigFromFile, mergeConfig, resolveConfig } from 'vite'

test('Desktop CJS 构建保留受限入口文件，并优先使用显式运行时入口', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pi-desktop-restricted-entry-')))
  try {
    const loaded = await loadConfigFromFile(
      {
        command: 'build',
        mode: 'production',
        root,
        forgeConfig: { build: [], renderer: [] },
        forgeConfigSelf: { entry: 'src/main/host-process.ts', config: 'vite.main.config.mts', target: 'main' },
      },
      path.join(root, 'vite.main.config.mts'),
    )
    assert.ok(loaded)
    await build(
      mergeConfig(loaded.config, {
        root,
        configFile: false,
        logLevel: 'silent',
        build: {
          outDir: directory,
          lib: {
            entry: path.resolve(root, '../../packages/plugin-runtime/src/restricted-runner.ts'),
            formats: ['cjs'],
            fileName: () => 'runner.cjs',
          },
          rollupOptions: { external: [/^node:/] },
        },
      }),
    )
    for (const override of ['', path.join(directory, 'runtime/restricted-entry.mjs')]) {
      await promisify(execFile)(
        process.execPath,
        [
          '-e',
          `const assert = require('node:assert/strict')
const fs = require('node:fs')
const { RestrictedRunner } = require(${JSON.stringify(path.join(directory, 'runner.cjs'))})
assert.equal(RestrictedRunner.entry, ${JSON.stringify(override || path.join(directory, 'restricted-entry.mjs'))})
assert.match(fs.readFileSync(${JSON.stringify(path.join(directory, 'restricted-entry.mjs'))}, 'utf8'), /AsyncLocalStorage/)`,
        ],
        { env: { ...process.env, PI_MEME_PLUGIN_ENTRY: override }, timeout: 5000 },
      )
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('Desktop 开发代理默认使用 3180，与构建 App 的 3185 隔离', async () => {
  vi.stubEnv('PI_MEME_PORT', undefined)
  const root = fileURLToPath(new URL('..', import.meta.url))
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
    const proxy = loaded.config.server?.proxy?.['/api']
    assert.ok(typeof proxy === 'object')
    assert.equal(proxy.target, 'http://127.0.0.1:3180')
    assert.equal(loaded.config.server?.port, 3181)
    assert.equal(loaded.config.server?.strictPort, true)
  } finally {
    vi.unstubAllEnvs()
  }
})

test.each([
  { port: undefined, url: undefined, target: 'http://127.0.0.1:3180' },
  { port: '31417', url: undefined, target: 'http://127.0.0.1:31417' },
  { port: '31417', url: 'http://127.0.0.1:31418', target: 'http://127.0.0.1:31418' },
])('Web 开发代理使用 $target，不继承正式 NODE_ENV', async ({ port, url, target }) => {
  vi.stubEnv('PI_MEME_PORT', port)
  vi.stubEnv('PI_MEME_HOST_URL', url)
  vi.stubEnv('NODE_ENV', 'production')
  const root = fileURLToPath(new URL('../../web', import.meta.url))
  try {
    const config = await resolveConfig({ root, configFile: path.join(root, 'vite.config.ts') }, 'serve')
    const proxy = config.server.proxy?.['/api']
    assert.ok(typeof proxy === 'object')
    assert.equal(proxy.target, target)
    assert.equal(config.server.port, 3181)
    assert.equal(config.server.strictPort, true)
    assert.equal(config.isProduction, false)
    assert.equal(process.env.NODE_ENV, 'development')
  } finally {
    vi.unstubAllEnvs()
  }
})

test('Web 正式构建配置保留 production 模式', async () => {
  vi.stubEnv('NODE_ENV', 'production')
  const root = fileURLToPath(new URL('../../web', import.meta.url))
  try {
    const config = await resolveConfig({ root, configFile: path.join(root, 'vite.config.ts') }, 'build')
    assert.equal(config.isProduction, true)
    assert.equal(process.env.NODE_ENV, 'production')
  } finally {
    vi.unstubAllEnvs()
  }
})

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
    assert.match(
      chat.code,
      /bridge\.prompt\(sessionKey, message, images, skills, \{\s*mode: messageMode,\s*\.\.\.audit,\s*\.\.\.submittedConfiguration,?\s*\}\)/,
    )
    assert.match(chat.code, /const sendMode = running \? ["']followUp["'] : ["']prompt["']/)
    assert.match(chat.code, /bridge\.steerQueueInput|bridge\[action\]\(key, id\)/)
    assert.match(
      chat.code,
      /bridge\.followUp\(sessionKey, message, images, skills, \{\s*mode: messageMode,\s*\.\.\.audit,\s*\.\.\.submittedConfiguration,?\s*\}\)/,
    )
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
