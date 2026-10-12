import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { SettingsManager } from '@earendil-works/pi-coding-agent'

type SettingsStorageLike = {
  withLock: (scope: 'global' | 'project', fn: (current: string | undefined) => string | undefined) => void
}

class DesktopSettingsStorage implements SettingsStorageLike {
  private readonly globalPath: string
  private readonly projectPath: string

  constructor(cwd: string, agentDir: string) {
    this.globalPath = path.join(agentDir, 'settings.json')
    this.projectPath = path.join(cwd, '.pi', 'settings.json')
  }

  withLock(scope: 'global' | 'project', fn: (current: string | undefined) => string | undefined) {
    const file = scope === 'global' ? this.globalPath : this.projectPath
    let current: string | undefined
    try {
      current = readFileSync(file, 'utf8')
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    }
    const next = fn(current)
    if (scope === 'project' || next === current || next === undefined) return
    mkdirSync(path.dirname(file), { recursive: true })
    const temporary = `${file}.tmp`
    try {
      writeFileSync(temporary, next, { mode: 0o600 })
      renameSync(temporary, file)
    } finally {
      rmSync(temporary, { force: true })
    }
  }
}

function inside(root: string, value: string) {
  const relative = path.relative(path.resolve(root), path.resolve(value))
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

/** 创建以 Desktop agentDir 为全局目录、并拦截所有项目设置写入的 SDK 设置管理器。 */
export function createDesktopSettingsManager(
  sdk: typeof import('@earendil-works/pi-coding-agent'),
  cwd: string,
  agentDir: string,
): SettingsManager {
  const manager = sdk.SettingsManager.fromStorage(new DesktopSettingsStorage(cwd, agentDir), { projectTrusted: true })
  const getSettings = manager.getSettings.bind(manager)
  const getProjectSettings = manager.getProjectSettings.bind(manager)
  manager.getPackages = () => []
  manager.getProjectSettings = () => {
    const settings = getProjectSettings()
    delete settings.packages
    delete settings.skills
    delete settings.extensions
    return settings
  }
  manager.getSettings = () => ({ ...getSettings(), packages: [], skills: [], extensions: [] })

  const projectPi = path.join(cwd, '.pi')
  const allow = (value: string) => {
    const resolved = path.resolve(value)
    return inside(agentDir, resolved) || inside(projectPi, resolved)
  }
  const filterPaths = (read: () => string[]) => () => read().filter(allow)
  manager.getExtensionPaths = () => []
  manager.getSkillPaths = () => []
  manager.getPromptTemplatePaths = filterPaths(manager.getPromptTemplatePaths.bind(manager))
  manager.getThemePaths = filterPaths(manager.getThemePaths.bind(manager))
  return manager
}
