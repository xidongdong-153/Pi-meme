import { build } from 'esbuild'
import { build as buildFrontend } from 'vite'
import { chmod, copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { copyPiRuntime } from './copy-pi-runtime.mjs'
import { preparePluginSkill } from './copy-builtin-skills.mjs'

const repo = fileURLToPath(new URL('..', import.meta.url))
const destination = process.argv[2]
if (!destination || !path.isAbsolute(destination)) throw new Error('缺少开发快照构建目标')
const desktop = process.argv[3] === 'desktop'
const { version } = JSON.parse(await readFile(path.join(repo, 'apps/desktop/package.json'), 'utf8')) as {
  version: string
}
const external = [
  'electron',
  '@earendil-works/chord',
  '@earendil-works/chord/*',
  '@earendil-works/pi-coding-agent',
  '@napi-rs/keyring',
  'node-pty',
  'esbuild',
  'jsonc-parser',
]
await mkdir(path.join(destination, 'server'), { recursive: true })
await writeFile(
  path.join(destination, 'package.json'),
  JSON.stringify({ name: 'pi-meme', productName: 'Pi meme', version, type: 'module', main: 'desktop/main.js' }),
)
await build({
  absWorkingDir: repo,
  entryPoints: {
    main: 'apps/server/src/main.ts',
    'session-worker': 'packages/host/src/session-worker.ts',
    'web-server': 'scripts/static-development-web.mts',
  },
  outdir: path.join(destination, 'server'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external,
  define: { __PI_MEME_VERSION__: JSON.stringify(version) },
  banner: {
    js: 'import {createRequire as __snapshotCreateRequire} from "node:module"; const require=__snapshotCreateRequire(import.meta.url);',
  },
})
if (desktop) {
  await mkdir(path.join(destination, 'desktop'), { recursive: true })
  await writeFile(path.join(destination, 'desktop/package.json'), '{"type":"commonjs"}')
  await build({
    absWorkingDir: repo,
    entryPoints: {
      main: 'apps/desktop/src/main/main.ts',
      'host-process': 'apps/desktop/src/main/host-process.ts',
      'storage-process': 'apps/desktop/src/main/storage-process.ts',
      preload: 'apps/desktop/src/preload/preload.ts',
      'browser-guest': 'apps/desktop/src/preload/browser-guest.ts',
      'browser-overlay': 'apps/desktop/src/preload/browser-overlay.ts',
    },
    outdir: path.join(destination, 'desktop'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external,
    define: { __PI_MEME_VERSION__: JSON.stringify(version), MAIN_WINDOW_VITE_DEV_SERVER_URL: 'undefined' },
  })
  const require = createRequire(path.join(repo, 'apps/desktop/package.json'))
  const electronRoot = path.dirname(require.resolve('electron/package.json'))
  // Preserve only relocatable links within Electron's own distribution; publication rejects escaping links.
  await cp(path.join(electronRoot, 'dist'), path.join(destination, 'electron'), {
    recursive: true,
    verbatimSymlinks: true,
  })
  await cp(path.join(repo, 'packages/assets/files/desktop/dock'), path.join(destination, 'assets/dock'), {
    recursive: true,
    dereference: true,
  })
}
await buildFrontend({
  root: path.join(repo, 'apps/web'),
  configFile: path.join(repo, 'apps/web/vite.config.ts'),
  build: { outDir: path.join(destination, 'frontend'), emptyOutDir: true, watch: null },
})
await copyPiRuntime(path.join(destination, 'node_modules'))
const modelsRequire = createRequire(path.join(repo, 'packages/models/package.json'))
await cp(
  path.dirname(modelsRequire.resolve('jsonc-parser/package.json')),
  path.join(destination, 'node_modules/jsonc-parser'),
  {
    recursive: true,
    dereference: true,
  },
)
await cp(path.join(repo, 'pi/skills'), path.join(destination, 'skills'), {
  recursive: true,
  dereference: true,
  filter: (source) => source !== path.join(repo, 'pi/skills/plugin-creator/dist'),
})
await preparePluginSkill(path.join(destination, 'skills'))
await mkdir(path.join(destination, 'runtime/bin'), { recursive: true })
const node = path.join(destination, 'runtime/bin', process.platform === 'win32' ? 'node.exe' : 'node')
await copyFile(process.execPath, node)
if (process.platform !== 'win32') await chmod(node, 0o755)
await copyFile(
  path.join(repo, 'packages/plugin-runtime/src/restricted-entry.mjs'),
  path.join(destination, 'runtime/restricted-entry.mjs'),
)
if (process.platform === 'win32') {
  const native = process.env.PI_MEME_WINDOWS_NATIVE
  if (!native || !path.isAbsolute(native)) throw new Error('Windows 开发快照缺少已构建的固定原生程序')
  await copyFile(native, path.join(destination, 'runtime/bin/pi-meme-windows.exe'))
}
