import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'vitest'
import { parse, stringify } from 'yaml'
import {
  assertPortableLinks,
  releaseAssetNames,
  releaseInfo,
  sha256,
  validateVersion,
  writeChecksums,
} from '../scripts/release.mjs'
import { writeThirdPartyLicenses } from '../scripts/release-licenses.mjs'
import { assertLockedDependencies, stageHostWorkspace } from '../scripts/release-workspace.mjs'

const version = '0.1.0-beta.1'

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
    await assert.rejects(writeChecksums(root), /三个预期平台包/)
    const names = releaseAssetNames((await releaseInfo()).version)
    for (const name of names) await writeFile(path.join(root, name), 'fixture')
    await writeFile(path.join(root, 'unexpected.zip'), 'fixture')
    await assert.rejects(writeChecksums(root), /三个预期平台包/)
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
