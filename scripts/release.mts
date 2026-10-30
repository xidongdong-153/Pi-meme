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

export async function pushRelease(root = repoRoot) {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  assert.equal(git('status', '--porcelain'), '', '工作区有未提交改动，请先提交本次版本和发布代码')
  const branch = git('branch', '--show-current')
  assert.ok(branch, '当前处于 detached HEAD，请切换到待发布分支')
  const desktop = JSON.parse(await readFile(path.join(root, 'apps/desktop/package.json'), 'utf8'))
  const server = JSON.parse(await readFile(path.join(root, 'apps/server/package.json'), 'utf8'))
  const version = validateVersion(desktop.version, server.version)
  const tag = `v${version}`
  const tagRef = `refs/tags/${tag}`
  const commit = git('rev-parse', 'HEAD')
  const remote = git('remote', 'get-url', '--push', 'origin')
  assert.equal(git('ls-remote', '--tags', remote, tagRef), '', `远端 Tag ${tag} 已存在，请使用新版本`)
  if (git('tag', '--list', tag)) {
    assert.equal(git('rev-parse', `${tagRef}^{commit}`), commit, `本地 Tag ${tag} 指向其他提交，不会移动它`)
  } else git('tag', tag, commit)
  console.log(`发布版本：${version}；分支：${branch}；commit：${commit}`)
  console.log(`推送到 origin，GitHub 构建成功后将自动公开${version.includes('-') ? '预发布' : '正式'}版本`)
  execFileSync(
    'git',
    ['push', '--atomic', '--no-follow-tags', 'origin', `refs/heads/${branch}:refs/heads/${branch}`, tagRef],
    { cwd: root, stdio: 'inherit' },
  )
  console.log(`已推送 ${tag}，请在 GitHub Actions 查看“构建发布包”的运行结果`)
}

export function releaseAssetNames(version: string) {
  return [
    `pi-meme-desktop-${version}-macos-arm64.zip`,
    `pi-meme-host-${version}-macos-arm64.tar.gz`,
    `pi-meme-host-${version}-linux-x64.tar.gz`,
    `pi-meme-desktop-${version}-windows-x64.zip`,
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

export async function checkWindowsDesktop(directory: string) {
  const resources = path.join(directory, 'resources')
  await checkMetadata(await readFile(path.join(resources, 'release.json'), 'utf8'), 'win32', 'x64', false)
  for (const name of [
    ...desktopResourceFiles,
    'app.asar',
    'runtime/bin/node.exe',
    'runtime/LICENSE',
    'runtime/restricted-entry.mjs',
  ])
    assert.ok((await lstat(path.join(resources, name))).size > 0, `Windows Desktop 缺少资源：${name}`)
  const executable = await readFile(path.join(directory, 'Pi meme.exe'))
  assert.ok(executable.length >= 64 && executable.toString('ascii', 0, 2) === 'MZ', 'Windows 应用不是 PE 可执行文件')
  const offset = executable.readUInt32LE(60)
  assert.ok(offset + 6 <= executable.length, 'Windows 应用 PE 头无效')
  assert.equal(executable.toString('ascii', offset, offset + 4), 'PE\0\0', 'Windows 应用 PE 签名无效')
  assert.equal(executable.readUInt16LE(offset + 4), 0x8664, 'Windows 应用必须为 x64')
  const runtime = JSON.parse(await readFile(path.join(resources, 'runtime/runtime.json'), 'utf8'))
  assert.equal(runtime.nodeVersion, nodeVersion, 'Windows Node 运行时版本不一致')
  assert.equal(runtime.platform, 'win32', 'Windows Node 运行时平台不一致')
  assert.equal(runtime.arch, 'x64', 'Windows Node 运行时架构不一致')
}

async function prepareDesktopAsset() {
  const windows = process.platform === 'win32'
  assert.ok(windows || process.platform === 'darwin', 'Desktop 发布包只在 macOS 或 Windows 构建')
  assert.equal(process.arch, windows ? 'x64' : 'arm64', 'Desktop 仅分发 macOS arm64 和 Windows x64')
  const { version } = await releaseInfo()
  const source = path.join(
    repoRoot,
    'apps/desktop/out/make/zip',
    process.platform,
    process.arch,
    `Pi meme-${process.platform}-${process.arch}-${version}.zip`,
  )
  const destination = path.join(releaseDirectory, releaseAssetNames(version)[windows ? 3 : 0])
  await mkdir(releaseDirectory, { recursive: true })
  await copyFile(source, destination)
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-meme desktop '))
  try {
    if (windows) {
      execFileSync('tar', ['-xf', destination, '-C', directory], { windowsHide: true })
      await checkWindowsDesktop(directory)
      console.log(destination)
      return
    }
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
    'Release 目录必须恰好包含四个预期平台包',
  )
  const lines: string[] = []
  for (const [index, name] of names.entries()) {
    const desktop = index === 0 || index === 3
    const file = path.join(directory, name)
    const stat = await lstat(file)
    assert.ok(stat.isFile() && stat.size > 0, `发布文件无效：${name}`)
    const metadata = execFileSync(
      desktop ? 'unzip' : 'tar',
      desktop
        ? ['-p', file, index === 3 ? 'resources/release.json' : 'Pi meme.app/Contents/Resources/release.json']
        : ['-xOf', file, 'pi-meme-host/release.json'],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 },
    )
    await checkMetadata(
      metadata,
      index === 3 ? 'win32' : index === 2 ? 'linux' : 'darwin',
      index >= 2 ? 'x64' : 'arm64',
      !desktop,
    )
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

Desktop 包含本机 Host；只使用桌面应用时无需再下载 Host。Host 包含 Web、Worker、内置技能、生产依赖和 Node.js ${nodeVersion}，不需要安装 pnpm 或 Pi CLI。

## 下载

- Apple Silicon Mac 桌面应用：\`${names[0]}\`
- Apple Silicon Mac 独立 Host：\`${names[1]}\`
- Linux x64 独立 Host：\`${names[2]}\`
- Windows x64 桌面应用：\`${names[3]}\`
- 下载后使用 \`SHA256SUMS\` 核验文件。

构建 commit：\`${commit}\`。构建目标为 macOS 15 arm64、Ubuntu 24.04 x64 和 Windows x64；不提供 Intel Mac、Linux arm64、Windows arm64 或 Alpine/musl 包。

## 安装与限制

Desktop 解压后将 Pi meme.app 放入 /Applications。macOS 使用 ad-hoc 签名，未做 Developer ID 签名与公证，首次打开可能被 Gatekeeper 阻止。仅在确认来源并校验文件后允许打开具体应用，不要关闭系统 Gatekeeper。

Windows Desktop 解压整个 ZIP 后运行 \`Pi meme.exe\`，需要 Git for Windows 及其 bash。Windows 包未配置代码签名、安装向导或自动更新。Windows 本机 Host 尚不支持受限权限、受限插件和 Agent 受管服务；需要受限执行时连接 macOS/Linux Host，不会自动切换为完全权限。

Host 解压后运行 \`./pi-meme-host/bin/pi-meme-host\`，访问 http://127.0.0.1:3185。需要 Git 和 bash；Linux 还需要可用的 bubblewrap。远程监听必须配置 HTTPS 证书、私钥和令牌。

数据默认位于 ~/.pi-meme。升级前退出旧 Host 的管理方并备份数据目录；不提供自动更新或自动注册系统服务，不承诺数据格式变化后的降级兼容。

安装、首次打开与校验步骤见[快速开始](https://github.com/xidongdong-153/Pi-meme/blob/v${version}/docs/getting-started.md)，远程部署见[Remote](https://github.com/xidongdong-153/Pi-meme/blob/v${version}/docs/remote.md)。

## 验收

自动流程执行静态检查，构建四个原生平台包，核对版本、commit、平台、架构与 SHA256，并检查 Desktop ZIP 内的许可文件、macOS 签名完整性及 Windows 可执行文件和 Node 运行时。发布 workflow 不运行源码测试、Web E2E 或产物运行测试；功能验收结果需由维护者另行记录。

附件上传并核对完整后自动公开；带预发布后缀的版本保留 Pre-release 标记。此流程未验证下载后的 Desktop 首次打开与 Host 实际部署。

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
  } else if (command === 'push') await pushRelease()
  else if (command === 'desktop') await prepareDesktopAsset()
  else if (command === 'checksums') {
    await writeChecksums(releaseDirectory)
    await writeReleaseNotes()
  } else throw new Error('用法：node --import tsx scripts/release.mts check|push|desktop|checksums')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  void main().catch((cause: unknown) => {
    console.error(cause instanceof Error ? cause.message : String(cause))
    process.exitCode = 1
  })
