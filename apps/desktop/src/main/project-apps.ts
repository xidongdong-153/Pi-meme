import { execFile } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ProjectApp } from '@pi-meme/contracts/desktop'

const execute = promisify(execFile)
const candidates = [
  { id: 'vscode', name: 'Visual Studio Code', bundleIds: ['com.microsoft.VSCode'] },
  { id: 'cursor', name: 'Cursor', bundleIds: ['com.todesktop.230313mzl4w4u92'] },
  { id: 'zed', name: 'Zed', bundleIds: ['dev.zed.Zed'] },
  { id: 'windsurf', name: 'Windsurf', bundleIds: ['com.exafunction.windsurf'] },
  { id: 'sublime-text', name: 'Sublime Text', bundleIds: ['com.sublimetext.4', 'com.sublimetext.3'] },
  { id: 'intellij-idea', name: 'IntelliJ IDEA', bundleIds: ['com.jetbrains.intellij', 'com.jetbrains.intellij.ce'] },
  { id: 'webstorm', name: 'WebStorm', bundleIds: ['com.jetbrains.WebStorm'] },
  { id: 'pycharm', name: 'PyCharm', bundleIds: ['com.jetbrains.pycharm', 'com.jetbrains.pycharm.ce'] },
  { id: 'goland', name: 'GoLand', bundleIds: ['com.jetbrains.goland'] },
  { id: 'phpstorm', name: 'PhpStorm', bundleIds: ['com.jetbrains.PhpStorm'] },
  { id: 'rubymine', name: 'RubyMine', bundleIds: ['com.jetbrains.rubymine'] },
  { id: 'clion', name: 'CLion', bundleIds: ['com.jetbrains.CLion'] },
  { id: 'rider', name: 'Rider', bundleIds: ['com.jetbrains.rider'] },
  { id: 'rustrover', name: 'RustRover', bundleIds: ['com.jetbrains.rustrover'] },
] satisfies Array<{ id: ProjectApp['id']; name: string; bundleIds: string[] }>

const appScript = `
ObjC.import('AppKit')
var candidates = ${JSON.stringify(candidates.map(({ id, bundleIds }) => ({ id, bundleIds })))}
var workspace = $.NSWorkspace.sharedWorkspace
var apps = []
candidates.forEach(function (candidate) {
  candidate.bundleIds.forEach(function (bundleId) {
    var url = workspace.URLForApplicationWithBundleIdentifier(bundleId)
    if (!url || url.isNil()) return
    var bundle = $.NSBundle.bundleWithURL(url)
    if (!bundle || bundle.isNil() || ObjC.unwrap(bundle.bundleIdentifier) !== bundleId) return
    apps.push({id: candidate.id, bundleId: bundleId, path: ObjC.unwrap(url.path)})
  })
})
JSON.stringify(apps)
`

type InstalledApp = ProjectApp & { path: string }
let inflight: Promise<InstalledApp[]> | undefined

async function probeProjectApps(): Promise<InstalledApp[]> {
  const { stdout } = await execute('/usr/bin/osascript', ['-l', 'JavaScript', '-e', appScript], {
    timeout: 5000,
    maxBuffer: 256 * 1024,
  })
  const value: unknown = JSON.parse(stdout)
  if (!Array.isArray(value)) throw new Error('系统应用列表格式无效')
  const entries: Array<{ id: string; bundleId: string; path: string }> = []
  for (const entry of value) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof entry.id !== 'string' ||
      typeof entry.bundleId !== 'string' ||
      typeof entry.path !== 'string' ||
      !path.isAbsolute(entry.path) ||
      entry.path.includes('\0') ||
      path.extname(entry.path) !== '.app' ||
      !candidates.some((candidate) => candidate.id === entry.id && candidate.bundleIds.includes(entry.bundleId))
    )
      throw new Error('系统应用列表格式无效')
    entries.push(entry)
  }
  const apps: InstalledApp[] = []
  const paths = new Set<string>()
  for (const candidate of candidates) {
    for (const bundleId of candidate.bundleIds) {
      const entry = entries.find((entry) => entry.id === candidate.id && entry.bundleId === bundleId)
      if (!entry) continue
      try {
        const target = await realpath(entry.path)
        if (!path.isAbsolute(target) || path.extname(target) !== '.app' || !(await stat(target)).isDirectory()) continue
        if (paths.has(target)) continue
        apps.push({ id: candidate.id, name: candidate.name, path: target })
        paths.add(target)
        break
      } catch (cause) {
        if (!['ENOENT', 'ENOTDIR'].includes((cause as NodeJS.ErrnoException).code ?? '')) throw cause
      }
    }
  }
  return apps
}

function installedProjectApps(): Promise<InstalledApp[]> {
  inflight ??= probeProjectApps()
    .catch((cause) => {
      throw new Error(`无法识别本机应用：${String(cause)}`)
    })
    .finally(() => {
      inflight = undefined
    })
  return inflight
}

export async function getProjectApps(): Promise<ProjectApp[]> {
  const apps = await installedProjectApps()
  return [{ id: 'finder', name: '系统文件管理器' }, ...apps.map(({ id, name }) => ({ id, name }))]
}

export async function openProjectInApp(id: unknown, cwd: string): Promise<void> {
  const candidate = candidates.find((candidate) => candidate.id === id)
  if (!candidate) throw new Error('项目打开方式无效')
  const installed = (await installedProjectApps()).find((app) => app.id === id)
  if (!installed) throw new Error(`${candidate.name} 未安装或已不可用`)
  try {
    await execute('/usr/bin/open', ['-a', installed.path, cwd], { timeout: 5000, maxBuffer: 256 * 1024 })
  } catch (cause) {
    throw new Error(`${candidate.name} 无法打开项目：${String(cause)}`)
  }
}
