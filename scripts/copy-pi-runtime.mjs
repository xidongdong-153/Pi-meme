/**
 * 把应用运行时需要的 Pi SDK 文件复制到打包目录（app.asar 内的 node_modules）。
 *
 * 复制内容：
 * - @earendil-works/pi-coding-agent：入口使用其自带的全量 bundle（dist/bundle/index.js），
 *   bundle 已内联绝大多数依赖，只需要再带上 jiti、quickjs-wasi 与 photon-node 三个外部资源。
 * - jiti：加载用户 TS 扩展。
 * - quickjs-wasi：codemode 的 wasm。
 * - @silvia-odwyer/photon-node：附件图片缩放。
 * - esbuild 与当前平台的 @esbuild 包：校验导入扩展的依赖与构建产物。
 *
 * 单独调试：
 *   node scripts/copy-pi-runtime.mjs /tmp/pi-runtime-check
 */
import fs from 'node:fs/promises'
import { build } from 'esbuild'
import path from 'node:path'
import { createRequire } from 'node:module'
import { prepareNodePty } from './prepare-node-pty.mjs'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = path.join(repoRoot, 'node_modules')

const piPackage = '@earendil-works/pi-coding-agent'

function copyFilter(source) {
  if (source.endsWith('.map')) return false
  if (path.basename(source) === 'node_modules') return false
  return true
}

function piPackageFilter(source) {
  if (!copyFilter(source)) return false
  const relative = path.relative(path.join(sourceRoot, piPackage), source)
  const head = relative.split(path.sep)[0]
  if (head === 'docs' || head === 'examples') return false
  if (relative === 'CHANGELOG.md' || relative === 'README.md') return false
  return true
}

export async function copyPiRuntime(targetDir) {
  const keyringAbi = process.platform === 'linux' ? '-gnu' : ''
  const packages = [
    { name: piPackage, filter: piPackageFilter },
    { name: '@earendil-works/chord', filter: copyFilter },
    { name: '@earendil-works/pi-agent-core', filter: copyFilter },
    { name: '@napi-rs/keyring', filter: copyFilter },
    { name: `@napi-rs/keyring-${process.platform}-${process.arch}${keyringAbi}`, filter: copyFilter },
    { name: 'jiti', filter: copyFilter },
    { name: 'quickjs-wasi', filter: copyFilter },
    { name: '@silvia-odwyer/photon-node', filter: copyFilter },
    { name: 'esbuild', filter: copyFilter },
    { name: `@esbuild/${process.platform}-${process.arch}`, filter: copyFilter },
  ]
  const copied = []
  for (const entry of packages) {
    const source = path.join(sourceRoot, ...entry.name.split('/'))
    const target = path.join(targetDir, ...entry.name.split('/'))
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.cp(source, target, { recursive: true, dereference: true, filter: entry.filter })
    copied.push(entry.name)
  }
  const hostRequire = createRequire(path.join(repoRoot, 'packages/host/package.json'))
  const ptyRoot = path.dirname(hostRequire.resolve('node-pty/package.json'))
  const ptyTarget = path.join(targetDir, 'node-pty')
  await fs.cp(ptyRoot, ptyTarget, { recursive: true, dereference: true, filter: copyFilter })
  await prepareNodePty(ptyTarget)
  copied.push('node-pty')
  const coreDirectory = path.join(targetDir, '@earendil-works/pi-agent-core')
  await build({
    entryPoints: [path.join(sourceRoot, '@earendil-works/pi-agent-core/dist/index.js')],
    outfile: path.join(coreDirectory, 'dist/index.bundle.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
  })
  return { targetDir, packages: copied }
}

if (process.argv[1] && process.argv[1].endsWith('copy-pi-runtime.mjs')) {
  const targetDir = process.argv[2]
  if (!targetDir) {
    console.error('用法：node scripts/copy-pi-runtime.mjs <目标 node_modules 目录>')
    process.exit(1)
  }
  const result = await copyPiRuntime(targetDir)
  console.log(`已复制 ${result.packages.length} 个包到 ${result.targetDir}`)
  for (const name of result.packages) console.log(`  ${name}`)
}
