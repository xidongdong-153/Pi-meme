import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { gzip, gunzip } from 'node:zlib'
import { validateBrowserModule } from './validate-ui'
import { parsePluginManifest, safeRelativePath, type PluginManifest } from '@pi-meme/plugin-sdk/manifest'

const compress = promisify(gzip)
const decompress = promisify(gunzip)
export const maxPluginPackageBytes = 32 * 1024 * 1024
export type PluginPackage = { format: 'pi-meme-plugin-v1'; files: Record<string, string> }

async function packagePath(root: string, relative: string) {
  let current = root
  for (const part of relative.split('/')) {
    current = path.join(current, part)
    if ((await lstat(current)).isSymbolicLink()) throw new Error(`插件包不能包含软链接：${relative}`)
  }
  const resolved = await realpath(current)
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`))
    throw new Error(`插件路径必须位于包内：${relative}`)
  return resolved
}

function resourceRoots(manifest: PluginManifest) {
  return [...(manifest.piMeme.resources?.skills ?? []), ...(manifest.piMeme.resources?.extensions ?? [])]
}

function allowedPackageFile(manifest: PluginManifest, relative: string) {
  return (
    ['package.json', 'README.md', 'LICENSE', 'LICENSE.md'].includes(relative) ||
    relative.startsWith('dist/') ||
    relative === manifest.piMeme.display?.icon ||
    resourceRoots(manifest).some((root) => relative === root || relative.startsWith(`${root}/`))
  )
}

export async function readPluginManifest(directory: string): Promise<PluginManifest> {
  const manifest = parsePluginManifest(JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')))
  const root = await realpath(directory)
  for (const kind of ['server', 'agent', 'ui'] as const) {
    const entry = manifest.piMeme[kind]
    if (!entry) continue
    const target = await packagePath(root, entry)
    if (!target.startsWith(`${root}${path.sep}`) || !(await lstat(target)).isFile())
      throw new Error(`插件 ${kind} 入口必须是包内文件`)
    if (kind === 'server') {
      const { readFacetBundleArtifact } = await import('@earendil-works/chord/node')
      const artifact = await readFacetBundleArtifact({ manifestPath: target, entry: 'server' })
      if (
        artifact.plugin.id !== manifest.name ||
        (artifact.plugin.version && artifact.plugin.version !== manifest.version)
      )
        throw new Error('Chord 构建产物与插件身份或版本不匹配')
    }
    if (kind === 'ui') {
      const code = await readFile(target, 'utf8')
      validateBrowserModule(code)
    }
  }
  if (manifest.piMeme.display?.icon) {
    const icon = await packagePath(root, manifest.piMeme.display.icon)
    if (!(await lstat(icon)).isFile()) throw new Error('插件图标必须是包内文件')
  }
  for (const skill of manifest.piMeme.resources?.skills ?? []) {
    const target = await packagePath(root, `${skill}/SKILL.md`)
    if (!(await lstat(target)).isFile()) throw new Error(`插件技能缺少 SKILL.md：${skill}`)
  }
  const extensionEntries = new Set(manifest.piMeme.agent ? [path.join(root, manifest.piMeme.agent)] : [])
  for (const extension of manifest.piMeme.resources?.extensions ?? []) {
    const target = await packagePath(root, extension)
    const info = await lstat(target)
    if (info.isDirectory()) {
      const entries = await readdir(target)
      const entry = ['index.ts', 'index.js', 'index.mjs'].find((name) => entries.includes(name))
      if (!entry) throw new Error(`插件扩展目录缺少 index.ts、index.js 或 index.mjs：${extension}`)
      const resolvedEntry = await packagePath(root, `${extension}/${entry}`)
      if (!(await lstat(resolvedEntry)).isFile()) throw new Error(`插件扩展入口必须是文件：${extension}/${entry}`)
      if (extensionEntries.has(resolvedEntry)) throw new Error('插件不能重复声明同一扩展入口')
      extensionEntries.add(resolvedEntry)
    } else if (!info.isFile() || !/\.(?:ts|js|mjs)$/.test(extension)) {
      throw new Error(`插件扩展必须是 .ts、.js、.mjs 文件或扩展目录：${extension}`)
    } else {
      if (extensionEntries.has(target)) throw new Error('插件不能重复声明同一扩展入口')
      extensionEntries.add(target)
    }
  }
  return manifest
}

export async function packPlugin(directory: string): Promise<Buffer> {
  const root = await realpath(directory)
  const manifest = await readPluginManifest(root)
  for (const entry of [manifest.piMeme.server, manifest.piMeme.agent, manifest.piMeme.ui])
    if (entry && !entry.startsWith('dist/')) throw new Error('打包入口必须位于 dist/；请使用 DevKit 构建')
  const files: Record<string, string> = {}
  let size = 0
  async function visit(relative: string) {
    if (Object.hasOwn(files, relative)) return
    const target = await packagePath(root, relative)
    const info = await lstat(target)
    if (info.isSymbolicLink()) throw new Error(`插件包不能包含软链接：${relative}`)
    if (info.isDirectory()) {
      for (const child of await readdir(target)) {
        if ((relative === 'dist' || relative.startsWith('dist/')) && child.startsWith('.')) continue
        await visit(relative ? `${relative}/${child}` : child)
      }
    } else if (info.isFile()) {
      const data = await readFile(target)
      size += data.length
      if (size > maxPluginPackageBytes) throw new Error('插件包解压大小不能超过 32 MiB')
      files[relative] = data.toString('base64')
    }
  }
  await visit('package.json')
  await visit('dist')
  for (const resource of resourceRoots(manifest)) await visit(resource)
  if (manifest.piMeme.display?.icon) await visit(manifest.piMeme.display.icon)
  for (const optional of ['README.md', 'LICENSE', 'LICENSE.md']) {
    if (
      await lstat(path.join(root, optional))
        .then(() => true)
        .catch(() => false)
    )
      await visit(optional)
  }
  return compress(JSON.stringify({ format: 'pi-meme-plugin-v1', files } satisfies PluginPackage))
}

export async function unpackPlugin(buffer: Buffer, directory: string) {
  if (buffer.length > maxPluginPackageBytes) throw new Error('插件上传不能超过 32 MiB')
  const decoded: unknown = JSON.parse(
    (await decompress(buffer, { maxOutputLength: maxPluginPackageBytes * 2 })).toString(),
  )
  if (
    !decoded ||
    typeof decoded !== 'object' ||
    !('format' in decoded) ||
    decoded.format !== 'pi-meme-plugin-v1' ||
    !('files' in decoded) ||
    !decoded.files ||
    typeof decoded.files !== 'object' ||
    Array.isArray(decoded.files)
  )
    throw new Error('插件包格式无效；请使用 DevKit 打包')
  const entries = Object.entries(decoded.files)
  if (!entries.length || entries.length > 10000) throw new Error('插件文件清单无效')
  const packageJson = (decoded.files as Record<string, unknown>)['package.json']
  if (typeof packageJson !== 'string') throw new Error('插件包格式无效：缺少 package.json')
  const manifest = parsePluginManifest(JSON.parse(Buffer.from(packageJson, 'base64').toString('utf8')))
  let size = 0
  for (const [name, value] of entries) {
    if (
      !safeRelativePath(name) ||
      !allowedPackageFile(manifest, name) ||
      typeof value !== 'string' ||
      value.length % 4 !== 0 ||
      /[^A-Za-z0-9+/=]/.test(value) ||
      (value.includes('=') && !/^={1,2}$/.test(value.slice(value.indexOf('='))))
    )
      throw new Error(`插件包文件无效：${name}`)
    const contents = Buffer.from(value, 'base64')
    size += contents.length
    if (size > maxPluginPackageBytes) throw new Error('插件包解压大小不能超过 32 MiB')
  }
  await mkdir(directory, { recursive: true })
  const root = await realpath(directory)
  for (const [name, value] of entries) {
    const target = path.join(root, name)
    let parent = root
    for (const part of name.split('/').slice(0, -1)) {
      parent = path.join(parent, part)
      try {
        const info = await lstat(parent)
        if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`插件解压目录无效：${name}`)
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
        await mkdir(parent)
      }
    }
    await writeFile(target, Buffer.from(value as string, 'base64'), { flag: 'wx' })
  }
  return readPluginManifest(directory)
}
