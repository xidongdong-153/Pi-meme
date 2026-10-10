import { lstat, readdir } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ProjectFile } from '@pi-meme/contracts/desktop'

const excluded = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'coverage', '.vite', '.next', '.venv'])

export class ProjectFileSearch {
  private cached?: { root: string; expires: number; entries: Promise<ProjectFile[]> }

  async list(cwd: string, query: string): Promise<ProjectFile[]> {
    const root = resolve(cwd)
    const slash = query.lastIndexOf('/')
    let entries: ProjectFile[]
    let fragment = query
    if (!query || slash >= 0) {
      const directory = slash < 0 ? '' : query.slice(0, slash + 1)
      fragment = slash < 0 ? '' : query.slice(slash + 1)
      const target = resolve(root, directory)
      const fromRoot = relative(root, target)
      if (isAbsolute(directory) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot))
        return []
      let current = root
      for (const segment of fromRoot.split(sep).filter(Boolean)) {
        if (excluded.has(segment)) return []
        current = join(current, segment)
        const status = await lstat(current).catch(() => null)
        if (!status?.isDirectory() || status.isSymbolicLink()) return []
      }
      entries = await readDirectory(target, directory)
    } else {
      if (!this.cached || this.cached.root !== root || this.cached.expires < Date.now()) {
        this.cached = { root, expires: Date.now() + 5000, entries: scan(root) }
      }
      entries = await this.cached.entries
    }
    const needle = fragment.toLowerCase()
    return entries
      .filter((entry) => !entry.path.split('/').some((part) => part.startsWith('.')) || fragment.startsWith('.'))
      .map((entry) => ({ entry, score: score(entry.path, needle) }))
      .filter((item) => item.score >= 0)
      .sort(
        (a, b) =>
          b.score - a.score || a.entry.kind.localeCompare(b.entry.kind) || a.entry.path.localeCompare(b.entry.path),
      )
      .slice(0, 50)
      .map((item) => item.entry)
  }
}

async function readDirectory(directory: string, prefix: string): Promise<ProjectFile[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  return entries.flatMap((entry): ProjectFile[] => {
    if (
      [...entry.name].some((character) => {
        const code = character.charCodeAt(0)
        return code < 32 || (code >= 127 && code <= 159) || character === '"'
      })
    )
      return []
    if (entry.isDirectory() && !excluded.has(entry.name)) return [{ path: prefix + entry.name, kind: 'directory' }]
    return entry.isFile() ? [{ path: prefix + entry.name, kind: 'file' }] : []
  })
}

async function scan(root: string) {
  const entries: ProjectFile[] = []
  const directories = ['']
  for (let cursor = 0; cursor < directories.length && entries.length < 10000; cursor++) {
    const prefix = directories[cursor]
    const children = await readDirectory(join(root, prefix), prefix).catch((error: unknown) => {
      if (!prefix) throw error
      return []
    })
    for (const entry of children) {
      entries.push(entry)
      if (entry.kind === 'directory') directories.push(`${entry.path}/`)
      if (entries.length >= 10000) break
    }
  }
  return entries
}

function score(path: string, query: string) {
  if (!query) return 0
  const value = path.toLowerCase()
  const name = value.slice(value.lastIndexOf('/') + 1)
  if (name === query) return 1000
  if (name.startsWith(query)) return 900
  if (name.includes(query)) return 700
  if (value.includes(query)) return 500
  let cursor = 0
  for (const character of query) {
    const found = value.indexOf(character, cursor)
    if (found < 0) return -1
    cursor = found + 1
  }
  return 300 - cursor
}
