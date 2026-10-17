import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { prepareNodePty } from './prepare-node-pty.mjs'
import {
  assertPortableLinks,
  nodeVersion,
  releaseAssetNames,
  releaseDirectory,
  releaseInfo,
  repoRoot,
  sha256,
  writeReleaseResources,
} from './release.mjs'

function pnpm(args: string[]) {
  assert.ok(process.env.npm_execpath, '请通过 pnpm package:host 执行打包')
  execFileSync(process.execPath, [process.env.npm_execpath, ...args], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, CI: 'true' },
  })
}

async function download(url: string, file: string) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(180_000) })
  if (!response.ok) throw new Error(`下载 Node.js 失败：${response.status} ${url}`)
  await writeFile(file, new Uint8Array(await response.arrayBuffer()))
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
    pnpm([
      '--filter',
      '@pi-meme/server',
      'deploy',
      '--prod',
      '--frozen-lockfile',
      '--registry=https://registry.npmjs.org',
      server,
    ])
    await prepareNodePty(path.join(server, 'node_modules/node-pty'))
    await cp(path.join(repoRoot, 'apps/web/dist'), path.join(bundle, 'apps/web/dist'), { recursive: true })
    for (const file of ['main.js', 'session-worker.js', 'skills/skill-creator/SKILL.md'])
      await readFile(path.join(server, 'dist', file))

    const distribution = `node-v${nodeVersion}-${process.platform}-${process.arch}`
    const archiveName = `${distribution}.tar.gz`
    const archive = path.join(directory, archiveName)
    const checksums = path.join(directory, 'SHASUMS256.txt')
    const base = `https://nodejs.org/dist/v${nodeVersion}`
    await download(`${base}/SHASUMS256.txt`, checksums)
    await download(`${base}/${archiveName}`, archive)
    const expected = (await readFile(checksums, 'utf8'))
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .find(([, file]) => file === archiveName)?.[0]
    assert.ok(expected && /^[a-f\d]{64}$/.test(expected), '官方校验清单缺少当前 Node.js 运行时')
    assert.equal(await sha256(archive), expected, 'Node.js 运行时 SHA256 校验失败')
    execFileSync('tar', ['-xzf', archive, '-C', directory])
    const runtime = path.join(bundle, 'runtime')
    await mkdir(path.join(runtime, 'bin'), { recursive: true })
    await copyFile(path.join(directory, distribution, 'bin/node'), path.join(runtime, 'bin/node'))
    await chmod(path.join(runtime, 'bin/node'), 0o755)
    await copyFile(path.join(directory, distribution, 'LICENSE'), path.join(runtime, 'LICENSE'))

    await mkdir(path.join(bundle, 'bin'), { recursive: true })
    const launcher = path.join(bundle, 'bin/pi-meme-host')
    await writeFile(
      launcher,
      `#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -P "$(dirname "$0")/.." && pwd)
PATH="$ROOT/runtime/bin:$PATH"
export PATH
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
