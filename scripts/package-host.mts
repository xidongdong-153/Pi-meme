import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { prepareNodePty } from './prepare-node-pty.mjs'
import { prepareNodeRuntime } from './node-runtime.mjs'
import { assertLockedDependencies, stageHostWorkspace } from './release-workspace.mjs'
import {
  assertPortableLinks,
  nodeVersion,
  releaseAssetNames,
  releaseDirectory,
  releaseInfo,
  repoRoot,
  writeReleaseResources,
} from './release.mjs'

function pnpm(args: string[], cwd = repoRoot) {
  assert.ok(process.env.npm_execpath, '请通过 pnpm package:host 执行打包')
  execFileSync(process.execPath, [process.env.npm_execpath, ...args], {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, CI: 'true' },
  })
}

async function main() {
  assert.ok(
    (process.platform === 'darwin' && process.arch === 'arm64') ||
      (process.platform === 'linux' && process.arch === 'x64'),
    '首发 Host 只能在 macOS arm64 或 Linux x64 原生构建',
  )
  assert.equal(process.versions.node, nodeVersion, `Host 打包必须使用 Node.js ${nodeVersion}`)
  const { version } = await releaseInfo()
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-meme-host-package-'))
  try {
    const bundle = path.join(directory, 'pi-meme-host')
    const server = path.join(bundle, 'apps/server')
    pnpm(['build:web'])
    pnpm(['build:server'])
    const workspace = path.join(directory, 'workspace')
    await stageHostWorkspace(repoRoot, workspace)
    pnpm(
      [
        'install',
        '--lockfile-only',
        '--ignore-scripts',
        '--no-frozen-lockfile',
        '--registry=https://registry.npmjs.org',
      ],
      workspace,
    )
    assertLockedDependencies(
      await readFile(path.join(repoRoot, 'pnpm-lock.yaml'), 'utf8'),
      await readFile(path.join(workspace, 'pnpm-lock.yaml'), 'utf8'),
    )
    pnpm(
      [
        '--filter',
        '@pi-meme/server',
        'deploy',
        '--prod',
        '--frozen-lockfile',
        '--registry=https://registry.npmjs.org',
        server,
      ],
      workspace,
    )
    await prepareNodePty(path.join(server, 'node_modules/node-pty'))
    await cp(path.join(repoRoot, 'apps/web/dist'), path.join(bundle, 'apps/web/dist'), { recursive: true })
    for (const file of ['main.js', 'session-worker.js', 'restricted-entry.mjs', 'skills/skill-creator/SKILL.md'])
      await readFile(path.join(server, 'dist', file))

    const runtime = path.join(bundle, 'runtime')
    await prepareNodeRuntime(runtime)

    await mkdir(path.join(bundle, 'bin'), { recursive: true })
    const launcher = path.join(bundle, 'bin/pi-meme-host')
    await writeFile(
      launcher,
      `#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -P "$(dirname "$0")/.." && pwd)
PATH="$ROOT/runtime/bin:$PATH"
PI_MEME_PLUGIN_NODE="$ROOT/runtime/bin/node"
PI_MEME_PLUGIN_ENTRY="$ROOT/runtime/restricted-entry.mjs"
export PATH PI_MEME_PLUGIN_NODE PI_MEME_PLUGIN_ENTRY
exec "$ROOT/runtime/bin/node" "$ROOT/apps/server/dist/main.js"
`,
      { mode: 0o755 },
    )
    await writeReleaseResources(bundle, 'host')
    await copyFile(path.join(repoRoot, 'apps/server/README.md'), path.join(bundle, 'README.md'))
    await assertPortableLinks(bundle)
    const actual = execFileSync(path.join(runtime, 'bin/node'), ['--version'], { encoding: 'utf8' }).trim()
    assert.equal(actual, `v${nodeVersion}`, '包内 Node.js 版本错误')
    await mkdir(releaseDirectory, { recursive: true })
    const destination = path.join(releaseDirectory, releaseAssetNames(version)[process.platform === 'darwin' ? 1 : 2])
    execFileSync('tar', ['-czf', destination, '-C', directory, 'pi-meme-host'], {
      stdio: 'inherit',
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    })
    console.log(`Host 分发包：${destination}`)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

void main().catch((cause: unknown) => {
  console.error(cause instanceof Error ? cause.message : String(cause))
  process.exitCode = 1
})
