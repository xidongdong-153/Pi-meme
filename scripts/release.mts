import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  appendFile,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeThirdPartyLicenses } from './release-licenses.mjs'

export const repoRoot = fileURLToPath(new URL('..', import.meta.url))
export const nodeVersion = '24.14.0'
export const releaseDirectory = path.join(repoRoot, 'out/release')
export const desktopResources = path.join(repoRoot, 'out/release-resources/desktop')
export const releaseResourceFiles = ['release.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_LICENSES.txt']
const desktopResourceFiles = [...releaseResourceFiles, 'ELECTRON_LICENSE', 'LICENSES.chromium.html']

export function validateVersion(desktop: string, server: string, tag?: string) {
  assert.match(desktop, /^\d+\.\d+\.\d+(?:-[a-z0-9]+(?:\.[a-z0-9]+)*)?$/i, '发布版本必须是无构建后缀的版本号')
  assert.equal(server, desktop, 'Desktop 与 Server 版本不一致')
  if (tag !== undefined) assert.equal(tag, `v${desktop}`, 'Tag 与应用版本不一致')
  return desktop
}

export async function releaseInfo() {
  const desktop = JSON.parse(await readFile(path.join(repoRoot, 'apps/desktop/package.json'), 'utf8'))
  const server = JSON.parse(await readFile(path.join(repoRoot, 'apps/server/package.json'), 'utf8'))
  const version = validateVersion(
    desktop.version,
    server.version,
    process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined,
  )
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  assert.match(commit, /^[a-f\d]{40}$/, '无法读取发布 commit')
  return { version, commit }
}

export function releaseAssetNames(version: string) {
  return [
    `pi-meme-desktop-${version}-macos-arm64.zip`,
    `pi-meme-host-${version}-macos-arm64.tar.gz`,
    `pi-meme-host-${version}-linux-x64.tar.gz`,
  ]
}

export async function writeReleaseResources(directory: string, runtime: 'desktop' | 'host') {
  const info = await releaseInfo()
  const require = createRequire(path.join(repoRoot, 'apps/desktop/package.json'))
  const runtimeVersion =
    runtime === 'host'
      ? { nodeVersion }
      : { electronVersion: JSON.parse(await readFile(require.resolve('electron/package.json'), 'utf8')).version }
  await mkdir(directory, { recursive: true })
  await writeFile(
    path.join(directory, 'release.json'),
    `${JSON.stringify({ ...info, platform: process.platform, arch: process.arch, ...runtimeVersion }, null, 2)}\n`,
  )
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md'])
    await copyFile(path.join(repoRoot, name), path.join(directory, name))
  await writeThirdPartyLicenses(repoRoot, path.join(directory, 'THIRD_PARTY_LICENSES.txt'))
}

export async function sha256(file: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

export async function assertPortableLinks(directory: string) {
  const root = await realpath(directory)
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isSymbolicLink()) continue
    const file = path.join(entry.parentPath, entry.name)
    assert.ok(!path.isAbsolute(await readlink(file)), `分发包包含绝对软链接：${path.relative(root, file)}`)
    const relative = path.relative(root, await realpath(file))
    assert.ok(
      relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
      `分发包的软链接越界：${path.relative(root, file)}`,
    )
  }
}

async function checkMetadata(value: string, platform: string, arch: string, host: boolean) {
  const metadata = JSON.parse(value)
  const info = await releaseInfo()
  assert.equal(metadata.version, info.version, '产物版本不一致')
  assert.equal(metadata.commit, info.commit, '产物 commit 不一致')
  assert.equal(metadata.platform, platform, '产物平台不一致')
  assert.equal(metadata.arch, arch, '产物架构不一致')
  if (host) assert.equal(metadata.nodeVersion, nodeVersion, 'Host Node 版本不一致')
}

async function prepareDesktopAsset() {
  assert.equal(process.platform, 'darwin', 'Desktop 发布包只在 macOS 构建')
  assert.equal(process.arch, 'arm64', '首发 Desktop 仅支持 arm64')
  const { version } = await releaseInfo()
  const source = path.join(repoRoot, 'apps/desktop/out/make/zip/darwin/arm64', `Pi meme-darwin-arm64-${version}.zip`)
  const destination = path.join(releaseDirectory, releaseAssetNames(version)[0])
  await mkdir(releaseDirectory, { recursive: true })
  await copyFile(source, destination)
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-meme desktop '))
  try {
    execFileSync('unzip', ['-q', destination, '-d', directory])
    const app = path.join(directory, 'Pi meme.app')
    const metadata = await readFile(path.join(app, 'Contents/Resources/release.json'), 'utf8')
    await checkMetadata(metadata, 'darwin', 'arm64', false)
    const bundleId = execFileSync(
      '/usr/libexec/PlistBuddy',
      ['-c', 'Print :CFBundleIdentifier', path.join(app, 'Contents/Info.plist')],
      { encoding: 'utf8' },
    ).trim()
    assert.equal(bundleId, 'io.github.xidongdong153.pi-meme')
    const appVersion = execFileSync(
      '/usr/libexec/PlistBuddy',
      ['-c', 'Print :CFBundleShortVersionString', path.join(app, 'Contents/Info.plist')],
      { encoding: 'utf8' },
    ).trim()
    assert.equal(appVersion, version, 'ZIP 中的应用版本不一致')
    execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
    for (const name of desktopResourceFiles)
      assert.ok((await lstat(path.join(app, 'Contents/Resources', name))).size > 0)
    console.log(destination)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export async function writeChecksums(directory: string) {
  const { version } = await releaseInfo()
  const names = releaseAssetNames(version)
  assert.deepEqual(
    (await readdir(directory)).filter((name) => name !== 'SHA256SUMS').sort(),
    [...names].sort(),
    'Release 目录必须恰好包含三个预期平台包',
  )
  const lines: string[] = []
  for (const [index, name] of names.entries()) {
    const file = path.join(directory, name)
    const stat = await lstat(file)
    assert.ok(stat.isFile() && stat.size > 0, `发布文件无效：${name}`)
    const metadata = execFileSync(
      index === 0 ? 'unzip' : 'tar',
      index === 0
        ? ['-p', file, 'Pi meme.app/Contents/Resources/release.json']
        : ['-xOf', file, 'pi-meme-host/release.json'],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 },
    )
    await checkMetadata(metadata, index === 2 ? 'linux' : 'darwin', index === 2 ? 'x64' : 'arm64', index !== 0)
    lines.push(`${await sha256(file)}  ${name}`)
  }
  await writeFile(path.join(directory, 'SHA256SUMS'), `${lines.join('\n')}\n`)
}

async function writeReleaseNotes() {
  const { version, commit } = await releaseInfo()
  const names = releaseAssetNames(version)
  await writeFile(
    path.join(repoRoot, 'out/release-notes.md'),
    `# Pi meme v${version}

首个公开预览版。Desktop 包含本机 Host；只使用桌面应用时无需再下载 Host。Host 包含 Web、Worker、内置技能、生产依赖和 Node.js ${nodeVersion}，不需要安装 pnpm 或 Pi CLI。

## 下载

- Apple Silicon Mac 桌面应用：\`${names[0]}\`
- Apple Silicon Mac 独立 Host：\`${names[1]}\`
- Linux x64 独立 Host：\`${names[2]}\`
- 下载后使用 \`SHA256SUMS\` 核验文件。

构建 commit：\`${commit}\`。首发验收基线为 macOS 15 arm64、Ubuntu 24.04 x64；不支持 Intel Mac、Linux arm64、Alpine/musl 或 Windows 原生运行。

## 安装与限制

Desktop 解压后将 Pi meme.app 放入 /Applications。macOS 使用 ad-hoc 签名，未做 Developer ID 签名与公证，首次打开可能被 Gatekeeper 阻止。仅在确认来源并校验文件后允许打开具体应用，不要关闭系统 Gatekeeper。

Host 解压后运行 \`./pi-meme-host/bin/pi-meme-host\`，访问 http://127.0.0.1:31415。需要 Git 和 bash；Linux 还需要可用的 bubblewrap。远程监听必须配置 HTTPS 证书、私钥和令牌。

数据默认位于 ~/.pi-meme。升级前退出旧 Host 的管理方并备份数据目录；不提供自动更新或自动注册系统服务，不承诺数据格式变化后的降级兼容。

安装、首次打开与校验步骤见[快速开始](https://github.com/xidongdong-153/Pi-meme/blob/v${version}/docs/getting-started.md)，远程部署见[Remote](https://github.com/xidongdong-153/Pi-meme/blob/v${version}/docs/remote.md)。

## 验收

自动流程已检查三个原生平台包、独立 Host 的静态页面、PTY、Worker、MCP、codemode、子代理、受限权限、重启恢复和正常停机，以及 Desktop 运行与完整签名。

发布前维护者仍需完成：

- [ ] 从草稿下载附件并重新核验 SHA256。
- [ ] 在非构建环境确认 macOS 首次打开流程。
- [ ] 抽查 Host 部署，补充本次已知问题后手动公开此预览版。

<!-- pi-meme-release-commit:${commit} -->
`,
  )
}

async function main() {
  const command = process.argv[2]
  if (command === 'check') {
    const { version, commit } = await releaseInfo()
    if (process.env.GITHUB_OUTPUT)
      await appendFile(
        process.env.GITHUB_OUTPUT,
        `version=${version}\ncommit=${commit}\nprerelease=${version.includes('-')}\n`,
      )
    console.log(`版本：${version}；commit：${commit}`)
  } else if (command === 'desktop') await prepareDesktopAsset()
  else if (command === 'checksums') {
    await writeChecksums(releaseDirectory)
    await writeReleaseNotes()
  } else throw new Error('用法：node --import tsx scripts/release.mts check|desktop|checksums')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  void main().catch((cause: unknown) => {
    console.error(cause instanceof Error ? cause.message : String(cause))
    process.exitCode = 1
  })
