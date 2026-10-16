import assert from 'node:assert/strict'
import { test } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { HostRpcResponse } from '@pi-meme/contracts/host'
import type { SettingsSnapshot } from '@pi-meme/contracts/settings'
import type { PluginDescriptor } from '@pi-meme/plugin-runtime/manager'
import { packPlugin } from '@pi-meme/plugin-runtime/package'
import { MemoryCredentialStorage } from '@pi-meme/pi-runtime/secure-store'
import { startHostServer } from '../src/server'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV8kAAAAASUVORK5CYII=',
  'base64',
)
const pluginId = '@test/theme-http'
const themeId = `${encodeURIComponent(pluginId)}:dark-image`
const themeInput = {
  id: 'dark-image',
  name: 'HTTP 图片主题',
  appearance: 'dark',
  tokens: { spacing: 1.1, radius: 12, surfaceOpacity: 0.8 },
  background: { image: 'assets/bg.png', area: 'workspace' },
}
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'pi-plugin-theme-http-')))
  const source = path.join(root, 'theme-package')
  await mkdir(path.join(source, 'themes'), { recursive: true })
  await mkdir(path.join(source, 'assets'))
  await writeFile(path.join(source, 'assets/bg.png'), png)
  const manifest = {
    name: pluginId,
    version: '1.0.0',
    type: 'module',
    piMeme: { sdkVersion: 2, resources: { themes: ['themes/dark.json'], assets: ['assets'] } },
  }
  await writeFile(path.join(source, 'package.json'), JSON.stringify(manifest))
  await writeFile(path.join(source, 'themes/dark.json'), JSON.stringify(themeInput))
  const server = await startHostServer({
    dataRoot: path.join(root, 'data'),
    token: 'theme-test-token',
    credentials: new MemoryCredentialStorage(),
  })
  const auth = await fetch(`${server.url}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'theme-test-token' }),
  })
  assert.equal(auth.status, 200)
  const cookie = auth.headers.get('set-cookie')!.split(';')[0]
  const response = async (method: string, args: unknown[] = []) => {
    const result = await fetch(`${server.url}/api/rpc`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: randomUUID(),
        clientId: 'theme-http-test',
        hostId: server.host.hostId,
        method,
        args,
      }),
    })
    assert.equal(result.status, 200)
    return (await result.json()) as HostRpcResponse
  }
  const rpc = async <T>(method: string, args: unknown[] = []) => {
    const value = await response(method, args)
    assert.equal(value.error, undefined, value.error?.message)
    return value.result as T
  }
  const settings = () => rpc<SettingsSnapshot>('settings:get')
  const waitTheme = async (enabled: boolean) => {
    const deadline = Date.now() + 5000
    let snapshot = await settings()
    while (snapshot.themes.some((theme) => theme.plugin?.id === pluginId) !== enabled) {
      if (Date.now() > deadline) throw new Error('等待主题插件列表更新超时')
      await delay(10)
      snapshot = await settings()
    }
    return snapshot
  }
  return {
    root,
    source,
    manifest,
    server,
    cookie,
    response,
    rpc,
    settings,
    waitTheme,
    package: async () => (await packPlugin(source)).toString('base64'),
    dispose: async () => {
      await server.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('纯数据主题插件经HTTP安装、枚举和选择，素材认证与路径边界生效，停用和卸载回退', { timeout: 20000 }, async () => {
  const f = await fixture()
  try {
    const installed = await f.rpc<PluginDescriptor>('plugins:install-package', [await f.package()])
    assert.equal(installed.id, pluginId)
    assert.deepEqual(installed.capabilities, { server: false, agent: false, ui: false, resources: true })
    const catalog = await f.waitTheme(true)
    const theme = catalog.themes.find((entry) => entry.id === themeId)!
    assert.equal(theme.name, 'HTTP 图片主题')
    assert.equal(theme.plugin?.generation, installed.generation)
    assert.equal(theme.tokens?.radius, 12)
    assert.ok(theme.background?.url)
    assert.ok(theme.background.url.startsWith('/api/plugins/'))
    const asset = `${f.server.url}${theme.background.url}`
    assert.equal((await fetch(asset)).status, 401)
    const authenticated = await fetch(asset, { headers: { Cookie: f.cookie } })
    assert.equal(authenticated.status, 200)
    assert.equal(authenticated.headers.get('content-type'), 'image/png')
    assert.deepEqual(Buffer.from(await authenticated.arrayBuffer()), png)
    const prefix = asset.slice(0, asset.lastIndexOf('/assets/'))
    for (const relative of ['assets/%2e%2e%2Fpackage.json', '%2e%2e%2Foutside.json', 'assets/%5c..%5coutside.png']) {
      const invalid = await fetch(`${prefix}/${relative}`, { headers: { Cookie: f.cookie } })
      assert.equal(invalid.status, 404)
    }
    const selected = await f.rpc<SettingsSnapshot>('settings:theme', [themeId])
    assert.equal(selected.settings.themeId, themeId)
    assert.equal(selected.settings.appearance?.darkThemeId, themeId)
    await f.rpc('plugins:disable', [pluginId])
    const disabled = await f.waitTheme(false)
    assert.equal(disabled.settings.themeId, 'dark')
    assert.equal(disabled.settings.appearance?.darkThemeId, 'dark')
    assert.equal((await fetch(asset, { headers: { Cookie: f.cookie } })).status, 404)
    await f.rpc('plugins:enable', [pluginId])
    const enabled = await f.waitTheme(true)
    assert.ok(enabled.themes.find((entry) => entry.id === themeId)!.plugin!.generation > installed.generation)
    await f.rpc('settings:theme', [themeId])
    await f.rpc('plugins:remove', [pluginId])
    const removed = await f.waitTheme(false)
    assert.equal(removed.settings.themeId, 'dark')
    assert.equal(
      (await f.rpc<PluginDescriptor[]>('plugins:list')).some((plugin) => plugin.id === pluginId),
      false,
    )
  } finally {
    await f.dispose()
  }
})

test('主题更新中的越界背景在切换前拒绝，旧版选择与认证图片保持可用', { timeout: 20000 }, async () => {
  const f = await fixture()
  try {
    const installed = await f.rpc<PluginDescriptor>('plugins:install-package', [await f.package()])
    const catalog = await f.waitTheme(true)
    const asset = `${f.server.url}${catalog.themes.find((entry) => entry.id === themeId)!.background!.url}`
    await f.rpc('settings:theme', [themeId])
    await writeFile(path.join(f.source, 'package.json'), JSON.stringify({ ...f.manifest, version: '2.0.0' }))
    await writeFile(
      path.join(f.source, 'themes/dark.json'),
      JSON.stringify({ ...themeInput, background: { image: '../outside.png' } }),
    )
    const failed = await f.response('plugins:install-package', [await f.package()])
    assert.match(failed.error?.message ?? '', /路径|包内|图片/)
    const current = (await f.rpc<PluginDescriptor[]>('plugins:list')).find((plugin) => plugin.id === pluginId)!
    assert.equal(current.version, '1.0.0')
    assert.equal(current.generation, installed.generation)
    assert.equal((await f.settings()).settings.themeId, themeId)
    const original = await fetch(asset, { headers: { Cookie: f.cookie } })
    assert.equal(original.status, 200)
    assert.deepEqual(Buffer.from(await original.arrayBuffer()), png)
  } finally {
    await f.dispose()
  }
})
