import { glob, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { SshCandidate } from '@pi-meme/contracts/ssh-connections'

/** 仅提取配置中的候选，不求值 Match，也不运行 ssh -G。 */
export async function discoverSshCandidates(home = homedir()): Promise<SshCandidate[]> {
  const directory = path.join(home, '.ssh')
  const visited = new Set<string>()
  const candidates = new Map<string, SshCandidate>()
  let bytes = 0
  async function visit(file: string, depth: number, optional = false) {
    if (depth > 16 || visited.size >= 128) throw new Error('SSH 配置 Include 超过读取限制')
    let resolved: string
    try {
      resolved = await realpath(file)
    } catch (cause) {
      if (optional && (cause as NodeJS.ErrnoException).code === 'ENOENT') return
      throw new Error('SSH 配置无法读取，请检查文件权限')
    }
    if (visited.has(resolved)) return
    visited.add(resolved)
    if ((await stat(resolved)).size + bytes > 1024 * 1024) throw new Error('SSH 配置超过 1 MiB 读取限制')
    const contents = await readFile(resolved, 'utf8')
    bytes += Buffer.byteLength(contents)
    if (bytes > 1024 * 1024) throw new Error('SSH 配置超过 1 MiB 读取限制')
    for (const line of contents.split(/\r?\n/)) {
      const words = sshConfigWords(line)
      const keyword = words.shift()?.toLowerCase()
      if (keyword === 'host') {
        for (const target of words) {
          if (!target || /[*?!\s\0]/.test(target) || target.startsWith('-')) continue
          if (!candidates.has(target)) candidates.set(target, { target, source: resolved })
        }
      } else if (keyword === 'include') {
        for (const pattern of words) {
          const expanded = pattern.startsWith('~/') ? path.join(home, pattern.slice(2)) : pattern
          const files: string[] = []
          for await (const match of glob(expanded, { cwd: directory })) {
            files.push(path.resolve(directory, match))
            if (files.length > 128) throw new Error('SSH 配置 Include 超过读取限制')
          }
          for (const included of files.sort()) await visit(included, depth + 1)
        }
      }
    }
  }
  await visit(path.join(directory, 'config'), 0, true)
  return [...candidates.values()]
}

function sshConfigWords(line: string) {
  const words: string[] = []
  let current = ''
  let quoted = ''
  let escaped = false
  for (const char of line.replace(/^(\s*\w+)\s*=\s*/, '$1 ')) {
    if (escaped) {
      current += char
      escaped = false
    } else if (char === '\\') escaped = true
    else if (quoted) {
      if (char === quoted) quoted = ''
      else current += char
    } else if (char === '"' || char === "'") quoted = char
    else if (char === '#') break
    else if (/\s/.test(char) || (char === '=' && words.length === 0)) {
      if (current) words.push(current)
      current = ''
    } else current += char
  }
  if (quoted || escaped) throw new Error('SSH 配置包含未闭合的引号或转义')
  if (current) words.push(current)
  return words
}
