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
import {
  isAppReleaseVersion,
  isReleaseNotes,
  maxReleaseManifestBytes,
  releaseAssetName,
  releaseAssetUrl,
  releaseRepositoryUrl,
  type AppReleaseAsset,
  type AppReleaseManifest,
  type AppReleaseTarget,
} from '@pi-meme/contracts/app-update'
import { writeThirdPartyLicenses } from './release-licenses.mjs'

export const repoRoot = fileURLToPath(new URL('..', import.meta.url))
export const nodeVersion = '24.14.0'
export const releaseDirectory = path.join(repoRoot, 'out/release')
export const desktopResources = path.join(repoRoot, 'out/release-resources/desktop')
export const releaseResourceFiles = ['release.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_LICENSES.txt']
const desktopResourceFiles = [...releaseResourceFiles, 'ELECTRON_LICENSE', 'LICENSES.chromium.html']

export function validateVersion(desktop: string, server: string, tag?: string) {
  assert.ok(isAppReleaseVersion(desktop), '发布版本必须是无构建后缀的版本号')
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

async function readVersionNotes(version: string, root = repoRoot) {
  const source = await readFile(path.join(root, 'docs/release-notes.md'), 'utf8')
  const [title, ...lines] = source.trim().split(/\r?\n/)
  assert.equal(title, `# v${version}`, 'docs/release-notes.md 的标题须与本次版本一致')
  const notes = lines.join('\n').trim()
  assert.ok(isReleaseNotes(notes), '请在 docs/release-notes.md 中填写本次版本的中文亮点')
  return notes
}

export async function pushRelease(root = repoRoot) {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  assert.equal(git('status', '--porcelain'), '', '工作区有未提交改动，请先提交本次版本和发布代码')
  const branch = git('branch', '--show-current')
  assert.ok(branch, '当前处于 detached HEAD，请切换到待发布分支')
  const desktop = JSON.parse(await readFile(path.join(root, 'apps/desktop/package.json'), 'utf8'))
  const server = JSON.parse(await readFile(path.join(root, 'apps/server/package.json'), 'utf8'))
  const version = validateVersion(desktop.version, server.version)
  await readVersionNotes(version, root)
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

const releaseTargets = [
  { kind: 'desktop', platform: 'darwin', arch: 'arm64', label: 'Apple Silicon Mac 桌面应用' },
  { kind: 'host', platform: 'darwin', arch: 'arm64', label: 'Apple Silicon Mac 独立 Host' },
  { kind: 'host', platform: 'linux', arch: 'x64', label: 'Linux x64 独立 Host' },
  { kind: 'desktop', platform: 'win32', arch: 'x64', label: 'Windows x64 桌面应用' },
  { kind: 'docker', platform: 'linux', arch: 'x64', label: 'Linux AMD64 Docker 镜像' },
  { kind: 'docker', platform: 'linux', arch: 'arm64', label: 'Linux ARM64 Docker 镜像（包括 Apple Silicon）' },
] satisfies (AppReleaseTarget & { label: string })[]

export function releaseAssetNames(version: string) {
  return releaseTargets.map((target) => releaseAssetName(version, target))
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

function checkMetadata(
  value: string,
  info: { version: string; commit: string },
  platform: string,
  arch: string,
  host: boolean,
) {
  const metadata = JSON.parse(value)
  assert.equal(metadata.version, info.version, '产物版本不一致')
  assert.equal(metadata.commit, info.commit, '产物 commit 不一致')
  assert.equal(metadata.platform, platform, '产物平台不一致')
  assert.equal(metadata.arch, arch, '产物架构不一致')
  if (host) assert.equal(metadata.nodeVersion, nodeVersion, 'Host Node 版本不一致')
}

export async function checkWindowsDesktop(directory: string) {
  const resources = path.join(directory, 'resources')
  checkMetadata(
    await readFile(path.join(resources, 'release.json'), 'utf8'),
    await releaseInfo(),
    'win32',
    'x64',
    false,
  )
  for (const name of [
    ...desktopResourceFiles,
    'app.asar',
    'runtime/bin/node.exe',
    'runtime/bin/pi-meme-windows.exe',
    'runtime/WINDOWS_NATIVE_LICENSES.txt',
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
  const native = await readFile(path.join(resources, 'runtime/bin/pi-meme-windows.exe'))
  assert.ok(native.length >= 64 && native.toString('ascii', 0, 2) === 'MZ', 'Windows 原生程序不是 PE 可执行文件')
  const nativeOffset = native.readUInt32LE(60)
  assert.ok(
    nativeOffset + 6 <= native.length && native.toString('ascii', nativeOffset, nativeOffset + 4) === 'PE\0\0',
    'Windows 原生程序 PE 头无效',
  )
  assert.equal(native.readUInt16LE(nativeOffset + 4), 0x8664, 'Windows 原生程序必须为 x64')
  const runtime = JSON.parse(await readFile(path.join(resources, 'runtime/runtime.json'), 'utf8'))
  assert.equal(runtime.nodeVersion, nodeVersion, 'Windows Node 运行时版本不一致')
  assert.equal(runtime.platform, 'win32', 'Windows Node 运行时平台不一致')
  assert.equal(runtime.arch, 'x64', 'Windows Node 运行时架构不一致')
}

async function prepareDesktopAsset() {
  const windows = process.platform === 'win32'
  assert.ok(windows || process.platform === 'darwin', 'Desktop 发布包只在 macOS 或 Windows 构建')
  assert.equal(process.arch, windows ? 'x64' : 'arm64', 'Desktop 仅分发 macOS arm64 和 Windows x64')
  const info = await releaseInfo()
  const { version } = info
  const source = path.join(
    repoRoot,
    'apps/desktop/out/make/zip',
    process.platform,
    process.arch,
    `Pi meme-${process.platform}-${process.arch}-${version}.zip`,
  )
  const destination = path.join(
    releaseDirectory,
    releaseAssetName(version, {
      kind: 'desktop',
      platform: windows ? 'win32' : 'darwin',
      arch: windows ? 'x64' : 'arm64',
    }),
  )
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
    checkMetadata(metadata, info, 'darwin', 'arm64', false)
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

function checkDockerArchive(file: string, version: string, commit: string, arch: 'amd64' | 'arm64') {
  const entry = (name: string) => JSON.parse(execFileSync('tar', ['-xOf', file, '--', name], { encoding: 'utf8' }))
  const manifest: { Config: string; RepoTags?: string[] | null }[] = entry('manifest.json')
  const tag = `pi-meme-host:${version}`
  const tagged = manifest.find(
    ({ RepoTags }) => RepoTags?.includes(tag) || RepoTags?.includes(`docker.io/library/${tag}`),
  )
  assert.ok(tagged, `Docker 镜像归档缺少标签 ${tag}`)
  const image = entry(tagged.Config)
  assert.equal(image.os, 'linux', 'Docker 镜像必须为 Linux')
  assert.equal(image.architecture, arch, `Docker 镜像必须为 ${arch}`)
  assert.equal(image.config.Labels['org.opencontainers.image.version'], version, 'Docker 镜像版本不一致')
  assert.equal(image.config.Labels['org.opencontainers.image.revision'], commit, 'Docker 镜像 commit 不一致')
}

export async function writeChecksums(directory: string) {
  const info = await releaseInfo()
  const { version, commit } = info
  const tag = `v${version}`
  const notes = await readVersionNotes(version)
  assert.deepEqual(
    (await readdir(directory)).filter((name) => name !== 'SHA256SUMS' && name !== 'latest.json').sort(),
    releaseAssetNames(version).sort(),
    'Release 目录必须包含四个平台包和两种原生架构的 Docker 镜像包',
  )
  const assets: AppReleaseAsset[] = []
  for (const target of releaseTargets) {
    const { kind, platform, arch } = target
    const name = releaseAssetName(version, target)
    const file = path.join(directory, name)
    const stat = await lstat(file)
    assert.ok(stat.isFile() && stat.size > 0, `发布文件无效：${name}`)
    if (kind === 'docker') {
      checkDockerArchive(file, version, commit, arch === 'x64' ? 'amd64' : 'arm64')
    } else {
      const desktop = kind === 'desktop'
      const metadata = execFileSync(
        desktop ? 'unzip' : 'tar',
        desktop
          ? [
              '-p',
              file,
              platform === 'win32' ? 'resources[/\\\\]release.json' : 'Pi meme.app/Contents/Resources/release.json',
            ]
          : ['-xOf', file, 'pi-meme-host/release.json'],
        { encoding: 'utf8', maxBuffer: 1024 * 1024 },
      )
      checkMetadata(metadata, info, platform, arch, !desktop)
    }
    assets.push({
      kind,
      platform,
      arch,
      name,
      url: releaseAssetUrl(version, target),
      size: stat.size,
      sha256: await sha256(file),
    })
  }
  const manifest: AppReleaseManifest = {
    version,
    tag,
    channel: version.includes('-') ? 'preview' : 'stable',
    notes,
    assets,
  }
  const contents = `${JSON.stringify(manifest, null, 2)}\n`
  assert.ok(Buffer.byteLength(contents) <= maxReleaseManifestBytes, '清单超过客户端读取上限，请缩短本次版本亮点')
  const lines = assets.map((asset) => `${asset.sha256}  ${asset.name}`)
  lines.push(`${createHash('sha256').update(contents).digest('hex')}  latest.json`)
  await writeFile(path.join(directory, 'latest.json'), contents)
  await writeFile(path.join(directory, 'SHA256SUMS'), `${lines.join('\n')}\n`)
  return { manifest, commit }
}

async function writeReleaseNotes({
  manifest: { version, tag, notes },
  commit,
}: Awaited<ReturnType<typeof writeChecksums>>) {
  const documentation = `${releaseRepositoryUrl}/blob/${tag}/docs`
  await writeFile(
    path.join(repoRoot, 'out/release-notes.md'),
    `# Pi meme v${version}

## 本版亮点

${notes}

Desktop 包含本机 Host；只使用桌面应用时无需再下载 Host。Host 包含 Web、Worker、内置技能、生产依赖和 Node.js ${nodeVersion}，不需要安装 pnpm 或 Pi CLI。

## 下载

${releaseTargets.map((target) => `- ${target.label} \`${releaseAssetName(version, target)}\``).join('\n')}
- Docker 部署使用同版本的 Compose 与沙箱策略，见[本地 Docker 部署](${documentation}/getting-started.md#本地-docker-部署)。
- 下载后使用 \`SHA256SUMS\` 核验文件。

构建 commit：\`${commit}\`。原生平台包面向 macOS 15 arm64、Ubuntu 24.04 x64 和 Windows x64；不提供 Intel Mac、Windows arm64 或 Alpine/musl 包。Docker 镜像分别在 Ubuntu 24.04 AMD64 和 ARM64 上构建。

## 安装与限制

Desktop 解压后将 Pi meme.app 放入 /Applications。macOS 使用 ad-hoc 签名，未做 Developer ID 签名与公证，首次打开可能被 Gatekeeper 阻止。仅在确认来源并校验文件后允许打开具体应用，不要关闭系统 Gatekeeper。

Windows Desktop 解压整个 ZIP 后运行 \`Pi meme.exe\`，需要 Git for Windows 及其 bash。Windows 包采用手动解压安装，未配置代码签名。本机 Host 的只读、工作区写入和受限插件使用原生 PSEC 沙箱，需要已更新的 Windows 11 24H2（26100.9278）、25H2（26200.9278）或更新版本；能力探测失败时明确报错，不自动改为完全权限。命令与 Agent 受管服务优先使用 PowerShell 7，缺失时使用 Windows PowerShell 5.1。

Host 解压后运行 \`./pi-meme-host/bin/pi-meme-host\`，访问 http://127.0.0.1:3185。需要 Git 和 bash；Linux 还需要可用的 bubblewrap。远程监听必须配置 HTTPS 证书、私钥和令牌。

## 升级注意

Desktop/Web 客户端与远程 Host 请同步升级。当前自有 API 已移除版本字段，客户端定向请求与回执增加连接、注册和文档代次；旧客户端或旧 Host 不能混用，直接调用 API 的集成需同步适配。

Pi SDK 与 Chord 已升级至 1.6.0。已有可信 Server 插件需使用 Chord 1.6.0 DevKit 重建。本地只读、工作区修改和 Plan 不再加载插件 Agent 或 MCP；需要使用它们时选择完全权限的普通任务并明确授权。

数据默认位于 ~/.pi-meme。升级前退出旧 Host 的管理方，备份数据目录，再手动替换安装包。系统服务由原管理方维护。数据格式变化后的降级需核对兼容性。

安装、首次打开与校验步骤见[快速开始](${documentation}/getting-started.md)，远程部署见[Remote](${documentation}/remote.md)。

## 验收

自动流程执行静态检查，构建四个原生平台包和两种架构的 Linux Docker 镜像，核对版本、commit、平台、架构与 SHA256，并检查 Desktop ZIP 内的许可文件、macOS 签名完整性及 Windows 可执行文件和 Node 运行时。发布 workflow 不运行源码测试、Web E2E 或产物运行测试；功能验收结果需由维护者另行记录。

附件上传并核对完整后自动公开；带预发布后缀的版本保留 Pre-release 标记。此流程未验证下载后的 Desktop 首次打开与 Host 实际部署。

<!-- pi-meme-release-commit:${commit} -->
`,
  )
}

async function main() {
  const command = process.argv[2]
  if (command === 'check') {
    const { version, commit } = await releaseInfo()
    await readVersionNotes(version)
    if (process.env.GITHUB_OUTPUT)
      await appendFile(
        process.env.GITHUB_OUTPUT,
        `version=${version}\ncommit=${commit}\nprerelease=${version.includes('-')}\n`,
      )
    console.log(`版本：${version}；commit：${commit}`)
  } else if (command === 'push') await pushRelease()
  else if (command === 'desktop') await prepareDesktopAsset()
  else if (command === 'checksums') {
    const release = await writeChecksums(releaseDirectory)
    await writeReleaseNotes(release)
  } else throw new Error('用法：node --import tsx scripts/release.mts check|push|desktop|checksums')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  void main().catch((cause: unknown) => {
    console.error(cause instanceof Error ? cause.message : String(cause))
    process.exitCode = 1
  })
