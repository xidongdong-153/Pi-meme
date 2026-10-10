import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'
import { createServer, loadConfigFromFile, mergeConfig } from 'vite'

const root = fileURLToPath(new URL('..', import.meta.url))
const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'pi-desktop-dev-smoke-'))
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
if (!loaded) throw new Error('无法读取 renderer 开发配置')
const config = mergeConfig({ resolve: { preserveSymlinks: true }, base: './' }, loaded.config)
const server = await createServer({
  ...config,
  root: path.resolve(root, '../web'),
  configFile: false,
  cacheDir,
  server: { host: '127.0.0.1', port: 0 },
})
try {
  await server.listen()
  const url = server.resolvedUrls?.local[0]
  if (!url) throw new Error('开发服务器没有提供页面地址')
  const child = spawn(electron, [path.join(root, 'tests/desktop-smoke.cjs')], {
    cwd: root,
    env: { ...process.env, PI_DESKTOP_DEV_SERVER_URL: url },
    stdio: 'inherit',
  })
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => resolve(code ?? 1))
  })
} finally {
  await server.close()
  await rm(cacheDir, { recursive: true, force: true })
}
