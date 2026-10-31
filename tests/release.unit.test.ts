import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'vitest'
import { parse, stringify } from 'yaml'
import {
  assertPortableLinks,
  checkWindowsDesktop,
  nodeVersion,
  pushRelease,
  releaseAssetNames,
  releaseInfo,
  sha256,
  validateVersion,
  writeChecksums,
} from '../scripts/release.mjs'
import { writeThirdPartyLicenses } from '../scripts/release-licenses.mjs'
import { assertLockedDependencies, stageHostWorkspace } from '../scripts/release-workspace.mjs'

const version = '0.1.0-beta.1'

async function withReleaseRepository(run: (root: string, git: (...args: string[]) => string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-meme-release-push-'))
  const root = path.join(directory, 'repo')
  await mkdir(root)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  try {
    git('init', '--initial-branch=main')
    git('config', 'user.name', '发布脚本测试')
    git('config', 'user.email', 'release@example.invalid')
    git('config', 'commit.gpgSign', 'false')
    git('config', 'tag.gpgSign', 'false')
    git('config', 'core.hooksPath', path.join(directory, 'no-hooks'))
    git('init', '--bare', path.join(directory, 'remote.git'))
    git('remote', 'add', 'origin', path.join(directory, 'remote.git'))
    for (const app of ['desktop', 'server']) {
      await mkdir(path.join(root, 'apps', app), { recursive: true })
      await writeFile(path.join(root, 'apps', app, 'package.json'), JSON.stringify({ version }))
    }
    git('add', '.')
    git('commit', '-m', '准备发布版本')
    await run(root, git)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('本地发布一起推送分支和版本 Tag，不附带其他 Tag，拒绝重复发布', async () => {
  await withReleaseRepository(async (root, git) => {
    git('tag', '-a', 'unrelated', '-m', '不发布的 Tag')
    git('config', 'push.followTags', 'true')
    await pushRelease(root)
    const commit = git('rev-parse', 'HEAD')
    assert.equal(git('ls-remote', 'origin', 'refs/heads/main'), `${commit}\trefs/heads/main`)
    assert.equal(git('ls-remote', '--tags', 'origin'), `${commit}\trefs/tags/v${version}`)
    await assert.rejects(pushRelease(root), /远端 Tag .* 已存在/)
  })
})

test('本地发布拒绝未提交改动、detached HEAD、版本不一致与指向其他提交的 Tag', async () => {
  await withReleaseRepository(async (root, git) => {
    const note = path.join(root, 'note.txt')
    await writeFile(note, '未提交')
    await assert.rejects(pushRelease(root), /未提交改动/)
    git('add', '.')
    await assert.rejects(pushRelease(root), /未提交改动/)
    git('commit', '-m', '提交说明')
    git('checkout', '--detach')
    await assert.rejects(pushRelease(root), /detached HEAD/)
    git('checkout', 'main')
    const server = path.join(root, 'apps/server/package.json')
    await writeFile(server, JSON.stringify({ version: '0.0.0' }))
    git('add', '.')
    git('commit', '-m', '制造不一致版本')
    await assert.rejects(pushRelease(root), /版本不一致/)
    git('tag', `v${version}`)
    await writeFile(server, JSON.stringify({ version }))
    git('add', '.')
    git('commit', '-m', '恢复版本')
    await assert.rejects(pushRelease(root), /本地 Tag .* 指向其他提交/)
    assert.equal(git('ls-remote', 'origin'), '')
  })
})

test('分支推送被拒绝时不发布 Tag，修复后可复用本地 Tag 重试', async () => {
  await withReleaseRepository(async (root, git) => {
    git('push', 'origin', 'main')
    const original = git('rev-parse', 'HEAD')
    await writeFile(path.join(root, 'note.txt'), '远端已有的新提交')
    git('add', '.')
    git('commit', '-m', '推进远端分支')
    git('push', 'origin', 'main')
    const remoteCommit = git('rev-parse', 'HEAD')
    git('reset', '--hard', original)
    await writeFile(path.join(root, 'note.txt'), '分叉的发布提交')
    git('add', '.')
    git('commit', '-m', '准备分叉版本')
    await assert.rejects(pushRelease(root))
    assert.equal(git('ls-remote', '--tags', 'origin'), '')
    assert.equal(git('ls-remote', 'origin', 'refs/heads/main'), `${remoteCommit}\trefs/heads/main`)
    const commit = git('rev-parse', 'HEAD')
    assert.equal(git('rev-parse', `v${version}`), commit)
    git('--git-dir', path.join(root, '../remote.git'), 'update-ref', 'refs/heads/main', original, remoteCommit)
    await pushRelease(root)
    assert.equal(git('ls-remote', '--tags', 'origin'), `${commit}\trefs/tags/v${version}`)
  })
})

test('第三方许可收集不跟进自有 workspace 链接，保留实际第三方许可', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-meme-release-licenses-'))
  try {
    await mkdir(path.join(root, 'node_modules/@pi-meme'), { recursive: true })
    await symlink('missing-workspace', path.join(root, 'node_modules/@pi-meme/host'))
    const dependency = path.join(root, 'node_modules/fixture-dependency')
    await mkdir(dependency)
    await writeFile(
      path.join(dependency, 'package.json'),
      JSON.stringify({ name: 'fixture-dependency', version: '1.0.0', license: 'MIT' }),
    )
    await writeFile(path.join(dependency, 'LICENSE'), 'Copyright fixture-dependency')
    for (const source of [
      'packages/ui/src/components/react-bits.LICENSE.md',
      'pi/skills/skill-creator/license.txt',
      'packages/assets/files/file-icons/LICENSE',
    ]) {
      await mkdir(path.dirname(path.join(root, source)), { recursive: true })
      await writeFile(path.join(root, source), '许可原文')
    }
    const output = path.join(root, 'THIRD_PARTY_LICENSES.txt')
    await writeThirdPartyLicenses(root, output)
    const content = await readFile(output, 'utf8')
    assert.match(content, /fixture-dependency@1\.0\.0/)
    assert.match(content, /Copyright fixture-dependency/)
    assert.match(content, /packages\/assets\/files\/file-icons\/LICENSE/)
    assert.doesNotMatch(content, /@pi-meme\/host/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Host 暂存仅启用自己的注入，保留构建产物并排除开发依赖和缓存', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-meme-release-workspace-'))
  const repo = path.join(root, 'repo')
  const workspace = path.join(root, 'workspace')
  const config = 'packages:\n  - apps/*\n  - packages/*\n  - plugins/*\n'
  const peers = { '@types/react': '^19.0.0', '@types/react-dom': '^19.0.0' }
  try {
    await mkdir(repo)
    for (const directory of ['apps', 'packages', 'plugins', 'patches']) await mkdir(path.join(repo, directory))
    for (const file of ['.npmrc', 'pnpm-lock.yaml']) await writeFile(path.join(repo, file), 'fixture')
    await writeFile(path.join(repo, 'package.json'), JSON.stringify({ devDependencies: {} }))
    await mkdir(path.join(repo, 'apps/desktop'), { recursive: true })
    await writeFile(path.join(repo, 'apps/desktop/package.json'), JSON.stringify({ devDependencies: peers }))
    await writeFile(path.join(repo, 'pnpm-workspace.yaml'), config)
    const files = [
      'apps/server/dist/main.js',
      'apps/server/node_modules/dependency/index.js',
      'apps/desktop/out/application',
      'apps/desktop/.vite/build/main.js',
      'apps/server/.env.local',
      'apps/server/tsconfig.tsbuildinfo',
    ]
    for (const file of files) {
      await mkdir(path.dirname(path.join(repo, file)), { recursive: true })
      await writeFile(path.join(repo, file), 'fixture')
    }
    await stageHostWorkspace(repo, workspace)
    assert.equal(await readFile(path.join(repo, 'pnpm-workspace.yaml'), 'utf8'), config)
    assert.deepEqual(JSON.parse(await readFile(path.join(repo, 'package.json'), 'utf8')).devDependencies, {})
    assert.deepEqual(JSON.parse(await readFile(path.join(workspace, 'package.json'), 'utf8')).devDependencies, peers)
    assert.equal(
      parse(await readFile(path.join(workspace, 'pnpm-workspace.yaml'), 'utf8')).injectWorkspacePackages,
      true,
    )
    assert.equal(await readFile(path.join(workspace, files[0]), 'utf8'), 'fixture')
    for (const file of files.slice(1)) await assert.rejects(readFile(path.join(workspace, file)), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('注入锁文件只能添加工作区副本，不得改变外部依赖版本、校验值或依赖图', () => {
  const before = {
    lockfileVersion: '9.0',
    packages: { 'fixture@1.0.0': { resolution: { integrity: 'sha512-fixture' } } },
    snapshots: { 'fixture@1.0.0': { dependencies: { leaf: '1.0.0' } } },
  }
  const after = {
    ...before,
    packages: {
      ...before.packages,
      '@pi-meme/host@file:packages/host': { resolution: { directory: 'packages/host' } },
    },
    snapshots: { ...before.snapshots, '@pi-meme/host@file:packages/host': { dependencies: { fixture: '1.0.0' } } },
  }
  assertLockedDependencies(stringify(before), stringify(after))
  const metadata = structuredClone(after)
  Object.assign(metadata.packages['fixture@1.0.0'], { deprecated: '更新声明' })
  assertLockedDependencies(stringify(before), stringify(metadata))
  const version = structuredClone(after)
  Object.assign(version.packages, { 'fixture@2.0.0': { resolution: { integrity: 'sha512-other' } } })
  assert.throws(() => assertLockedDependencies(stringify(before), stringify(version)), /外部依赖/)
  const checksum = structuredClone(after)
  checksum.packages['fixture@1.0.0'].resolution.integrity = 'sha512-other'
  assert.throws(() => assertLockedDependencies(stringify(before), stringify(checksum)), /校验值/)
  const graph = structuredClone(after)
  graph.snapshots['fixture@1.0.0'].dependencies.leaf = '2.0.0'
  assert.throws(() => assertLockedDependencies(stringify(before), stringify(graph)), /依赖图/)
  const context = structuredClone(after)
  Object.assign(context.snapshots, { 'fixture@1.0.0(peer@1.0.0)': { dependencies: { leaf: '1.0.0' } } })
  assert.throws(() => assertLockedDependencies(stringify(before), stringify(context)), /依赖图/)
})

test('Desktop、Host 和 Tag 必须使用同一个可分发版本', () => {
  assert.equal(validateVersion(version, version, `v${version}`), version)
  assert.equal(validateVersion('0.1.0', '0.1.0'), '0.1.0')
  assert.throws(() => validateVersion(version, '0.0.0'), /版本不一致/)
  assert.throws(() => validateVersion(version, version, 'v1.0.0'), /Tag/)
  for (const invalid of ['../escape', '1.0', '1.0.0+local', '1.0.0-beta..1'])
    assert.throws(() => validateVersion(invalid, invalid), /发布版本/)
  assert.deepEqual(releaseAssetNames(version), [
    `pi-meme-desktop-${version}-macos-arm64.zip`,
    `pi-meme-host-${version}-macos-arm64.tar.gz`,
    `pi-meme-host-${version}-linux-x64.tar.gz`,
    `pi-meme-desktop-${version}-windows-x64.zip`,
  ])
})

test('分发包允许相对内部软链接，拒绝越界、绝对和失效软链接', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-meme-release-links-'))
  const bundle = path.join(root, 'bundle')
  await mkdir(path.join(bundle, 'modules'), { recursive: true })
  await writeFile(path.join(bundle, 'modules/entry.js'), 'export {}')
  await symlink('modules/entry.js', path.join(bundle, 'entry.js'))
  try {
    await assertPortableLinks(bundle)
    const invalid = path.join(bundle, 'invalid')
    for (const target of ['../outside', path.join(bundle, 'entry.js'), 'missing']) {
      if (target === '../outside') await writeFile(path.join(root, 'outside'), 'outside')
      await symlink(target, invalid)
      await assert.rejects(assertPortableLinks(bundle))
      await rm(invalid)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('校验和不能把缺少平台、额外文件或软链接发布文件当作完整 Release', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-meme-release-sums-'))
  try {
    await assert.rejects(writeChecksums(root), /四个预期平台包/)
    const names = releaseAssetNames((await releaseInfo()).version)
    for (const name of names.slice(0, 3)) await writeFile(path.join(root, name), 'fixture')
    await assert.rejects(writeChecksums(root), /四个预期平台包/)
    await writeFile(path.join(root, names[3]), 'fixture')
    await writeFile(path.join(root, 'unexpected.zip'), 'fixture')
    await assert.rejects(writeChecksums(root), /四个预期平台包/)
    await rm(path.join(root, 'unexpected.zip'))
    await rm(path.join(root, names[0]))
    await symlink(names[1], path.join(root, names[0]))
    await assert.rejects(writeChecksums(root), /发布文件无效/)
    assert.equal(
      await sha256(path.join(root, names[1])),
      'f16d05ec6b29248d2c61adb1e9263f78e4f7bace1b955014a2d17872cfe4064d',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Windows 发布包检查可执行文件、Node 运行时与平台元数据', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-windows-release-'))
  const resources = path.join(root, 'resources')
  await mkdir(path.join(resources, 'runtime/bin'), { recursive: true })
  const executable = Buffer.alloc(128)
  executable.write('MZ')
  executable.writeUInt32LE(64, 60)
  executable.write('PE\0\0', 64)
  executable.writeUInt16LE(0x8664, 68)
  const metadata = { ...(await releaseInfo()), platform: 'win32', arch: 'x64' }
  const runtime = { nodeVersion, platform: 'win32', arch: 'x64' }
  try {
    for (const name of [
      'LICENSE',
      'THIRD_PARTY_NOTICES.md',
      'THIRD_PARTY_LICENSES.txt',
      'ELECTRON_LICENSE',
      'LICENSES.chromium.html',
      'app.asar',
      'runtime/bin/node.exe',
      'runtime/WINDOWS_NATIVE_LICENSES.txt',
      'runtime/LICENSE',
      'runtime/restricted-entry.mjs',
    ])
      await writeFile(path.join(resources, name), 'fixture')
    await writeFile(path.join(root, 'Pi meme.exe'), executable)
    await writeFile(path.join(resources, 'runtime/bin/pi-meme-windows.exe'), executable)
    await writeFile(path.join(resources, 'release.json'), JSON.stringify(metadata))
    await writeFile(path.join(resources, 'runtime/runtime.json'), JSON.stringify(runtime))
    await checkWindowsDesktop(root)
    executable.writeUInt16LE(0xaa64, 68)
    await writeFile(path.join(root, 'Pi meme.exe'), executable)
    await assert.rejects(checkWindowsDesktop(root), /必须为 x64/)
    executable.writeUInt16LE(0x8664, 68)
    await writeFile(path.join(root, 'Pi meme.exe'), executable)
    await writeFile(path.join(resources, 'runtime/runtime.json'), JSON.stringify({ ...runtime, platform: 'darwin' }))
    await assert.rejects(checkWindowsDesktop(root), /运行时平台不一致/)
    await writeFile(path.join(resources, 'release.json'), JSON.stringify({ ...metadata, commit: 'wrong' }))
    await assert.rejects(checkWindowsDesktop(root), /commit 不一致/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
