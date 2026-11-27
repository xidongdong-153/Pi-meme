import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { parse, visit, type ParseError } from 'jsonc-parser'
import type { PromptTemplate } from '@earendil-works/pi-coding-agent'
import { builtinCommands } from '@pi-meme/contracts/pi'
import { storageLayoutRelativePaths } from '@pi-meme/contracts/storage-paths'
import { loadPiSdk, type PiSdk } from '@pi-meme/pi-runtime/sdk/load'
import { optionalStat, physicalPath } from './storage/files'

export type JsonRecord = Record<string, unknown>

export function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : undefined
}

export function readObject(content: string, name: string) {
  const errors: ParseError[] = []
  const text = content.replace(/^\uFEFF/, '')
  const options = { allowTrailingComma: true }
  visit(
    text,
    {
      onObjectProperty: (key) => {
        if (key === '__proto__') throw new Error(`${name} 含不支持的 JSON 属性`)
      },
    },
    options,
  )
  const value = record(parse(text, errors, options))
  if (!value || errors.length) throw new Error(`${name} 格式无效，请检查 JSON`)
  return value
}

export function compareValue(value: unknown): string {
  return (
    JSON.stringify(value, (_key, item: unknown) => {
      const object = record(item)
      return object
        ? Object.fromEntries(
            Object.keys(object)
              .sort()
              .map((name) => [name, object[name]]),
          )
        : item
    }) ?? ''
  )
}

export function displayText(value: string) {
  return value.length > 2_400 ? `${value.slice(0, 2_400)}\n…（预览已截断）` : value
}

export async function listDirectory(root: string, relative: string) {
  const directory = await physicalPath(root, relative)
  if (!directory) return []
  return (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
}

export async function readConfigFile(root: string, relative: string) {
  const target = await physicalPath(root, relative)
  if (!target) return undefined
  const initial = await optionalStat(target)
  if (!initial?.isFile()) throw new Error('配置路径必须是普通文件')
  const maxSize = 4 * 1024 * 1024
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.ino !== initial.ino || info.dev !== initial.dev || (await realpath(target)) !== target)
      throw new Error('配置文件在读取期间被替换')
    if (info.size > maxSize) throw new Error('单个配置文件超过 4 MiB')
    const buffer = Buffer.alloc(info.size + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    const end = await handle.stat()
    if (length !== info.size || end.mtimeMs !== info.mtimeMs || end.ctimeMs !== info.ctimeMs)
      throw new Error('配置文件在读取期间变化')
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length))
  } finally {
    await handle.close()
  }
}

export function parsePiPrompt(
  file: string,
  content: string,
  parseFrontmatter: PiSdk['parseFrontmatter'],
): PromptTemplate {
  const name = path.basename(file, '.md')
  if (
    !name ||
    /[\s/\\]/u.test(name) ||
    ['计划', '计划模式'].includes(name) ||
    builtinCommands.some((command) => command.name === name)
  )
    throw new Error('提示词名称无法用作 Pi meme 的斜杠命令')
  const { frontmatter, body } = parseFrontmatter(content)
  const firstLine = body.split('\n').find((line) => line.trim()) ?? ''
  const description =
    typeof frontmatter.description === 'string' && frontmatter.description
      ? frontmatter.description
      : firstLine.length > 60
        ? `${firstLine.slice(0, 60)}...`
        : firstLine
  return {
    name,
    description,
    argumentHint: typeof frontmatter['argument-hint'] === 'string' ? frontmatter['argument-hint'] : undefined,
    content: body,
    filePath: file,
    sourceInfo: { path: file, source: 'local', scope: 'user', origin: 'top-level', baseDir: path.dirname(file) },
  }
}

export async function readPiPrompts(root: string) {
  const directory = storageLayoutRelativePaths.agentPromptsDirectory
  const files = await listDirectory(root, directory).catch(() => [])
  if (!files.length) return []
  const { parseFrontmatter } = await loadPiSdk()
  const prompts: PromptTemplate[] = []
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith('.md')) continue
    const relative = path.join(directory, file.name)
    try {
      const content = await readConfigFile(root, relative)
      if (content !== undefined) prompts.push(parsePiPrompt(path.join(root, relative), content, parseFrontmatter))
    } catch {
      // A damaged local template does not hide other commands or prevent session startup.
    }
  }
  return prompts
}

export async function replaceConfigFile(root: string, relative: string, expected: string | undefined, content: string) {
  const parent = path.dirname(relative)
  const canonical = await realpath(root)
  if (!(await physicalPath(canonical, parent)))
    await mkdir(path.join(canonical, parent), { recursive: true, mode: 0o700 })
  const directory = await physicalPath(canonical, parent)
  if (!directory) throw new Error('目标配置目录不可用')
  const temporary = path.join(directory, `.pi-import-${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(content)
    await handle.sync()
    await handle.close()
    if ((await readConfigFile(canonical, relative)) !== expected) throw new Error('目标配置已变化，请重新扫描')
    await rename(temporary, path.join(canonical, relative))
  } finally {
    await handle.close().catch(() => {})
    await rm(temporary, { force: true }).catch(() => {})
  }
}
