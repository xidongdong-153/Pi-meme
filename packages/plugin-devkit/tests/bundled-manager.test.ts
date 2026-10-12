import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { createPlugin } from '../src/create'
import { buildPlugin, packagePlugin } from '../src/build'

for (const format of ['cjs', 'esm'] as const) {
  test(`${format} Host 产物从临时目录安装 DevKit Server 包并共享 Chord 公开模块`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-meme-bundled-manager-'))
    const directory = path.join(root, 'probe')
    try {
      await createPlugin(directory, 'bundled-server-probe')
      await symlink(path.resolve(import.meta.dirname, '../../../node_modules'), path.join(root, 'node_modules'), 'dir')
      await writeFile(
        path.join(directory, 'src/server/entry.ts'),
        `import { defineService } from '@earendil-works/chord'
import { createContextKey } from '@earendil-works/chord/context'
import { isBuiltin } from 'node:module'
export function create(context) {
  context.registerHandlers({
    [context.pluginId + ':identity']: () => ({ defineService, createContextKey, builtin: isBuiltin('node:fs') }),
  })
}`,
      )
      await buildPlugin(directory)
      const packed = await packagePlugin(directory, path.join(root, 'probe.pim'))
      const entry = path.join(root, 'host.ts')
      await writeFile(
        entry,
        `import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PluginManager } from ${JSON.stringify(fileURLToPath(import.meta.resolve('@pi-meme/plugin-runtime/manager')))}
async function main() {
  const manager = new PluginManager({directory:${JSON.stringify(path.join(root, 'installed'))}, dataDirectory:${JSON.stringify(path.join(root, 'data'))}})
  try {
    const installed = await manager.installPackage(await readFile(${JSON.stringify(packed)}))
    assert.equal(installed.status, 'active')
    const result = await manager.handlers()['bundled-server-probe:identity']()
    assert.equal(result.defineService, (await import('@earendil-works/chord')).defineService)
    assert.equal(result.createContextKey, (await import('@earendil-works/chord/context')).createContextKey)
    assert.equal(result.builtin, true)
    await manager.disable(installed.id)
    await manager.enable(installed.id)
    await manager.reload(installed.id)
    assert.equal((await manager.handlers()['bundled-server-probe:identity']()).builtin, true)
    console.log('打包 Server 插件已安装并重载')
  } finally { await manager.dispose() }
}
main().catch(cause => { console.error(cause); process.exitCode = 1 })`,
      )
      const outfile = path.join(root, `host.${format === 'cjs' ? 'cjs' : 'mjs'}`)
      await build({
        entryPoints: [entry],
        outfile,
        bundle: true,
        format,
        platform: 'node',
        target: 'node22',
        external: ['@earendil-works/chord', '@earendil-works/chord/*', '@earendil-works/pi-coding-agent', 'esbuild'],
        logLevel: 'silent',
      })
      const bundle = await readFile(outfile, 'utf8')
      assert.ok(bundle.includes('PluginManager = class'), '测试必须执行真实捆绑后的 PluginManager')
      const result = await promisify(execFile)(process.execPath, [outfile], { cwd: root })
      assert.match(result.stdout, /打包 Server 插件已安装并重载/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}
