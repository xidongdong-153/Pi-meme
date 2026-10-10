import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { readFacetBundleArtifact } from '@earendil-works/chord/node'
import { gzip, gunzip } from 'node:zlib'
import { validateBrowserModule } from './validate-ui'
import { parsePluginManifest, safeRelativePath, type PluginManifest } from '@pi-meme/plugin-sdk/manifest'

const compress = promisify(gzip)
const decompress = promisify(gunzip)
export const maxPluginPackageBytes = 32 * 1024 * 1024
export type PluginPackage = { format: 'pi-meme-plugin-v1'; files: Record<string, string> }

export async function readPluginManifest(directory: string): Promise<PluginManifest> {
  const manifest = parsePluginManifest(JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')))
  const root = await realpath(directory)
  for (const kind of ['server', 'agent', 'ui'] as const) {
    const entry = manifest.piMeme[kind]
    if (!entry) continue
    const target = await realpath(path.join(root, entry))
    if (!target.startsWith(`${root}${path.sep}`) || !(await lstat(target)).isFile())
      throw new Error(`插件 ${kind} 入口必须是包内文件`)
    if (kind === 'server') {
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
    const target = path.join(root, relative)
    const info = await lstat(target)
    if (info.isSymbolicLink()) throw new Error(`插件包不能包含软链接：${relative}`)
    if (info.isDirectory()) {
      for (const child of await readdir(target)) {
        if (child.startsWith('.')) continue
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
  let size = 0
  for (const [name, value] of entries) {
    if (
      !safeRelativePath(name) ||
      typeof value !== 'string' ||
      value.length % 4 !== 0 ||
      /[^A-Za-z0-9+/=]/.test(value) ||
      (value.includes('=') && !/^={1,2}$/.test(value.slice(value.indexOf('='))))
    )
      throw new Error(`插件包文件无效：${name}`)
    const contents = Buffer.from(value, 'base64')
    size += contents.length
    if (size > maxPluginPackageBytes) throw new Error('插件包解压大小不能超过 32 MiB')
    const target = path.join(directory, name)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, contents, { flag: 'wx' })
  }
  return readPluginManifest(directory)
}
