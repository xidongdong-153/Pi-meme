import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { DesktopProject, WorkspaceKind } from '@pi-meme/contracts/sessions'

export class ProjectStore {
  private projects: DesktopProject[] = []
  private loadError?: Error
  private saving: Promise<void> = Promise.resolve()
  private standaloneRoot: string
  private readonly file: string

  constructor(directory: string) {
    this.file = path.join(directory, 'projects.json')
    this.standaloneRoot = path.join(directory, 'standalone-workspaces')
  }

  async load() {
    await mkdir(this.standaloneRoot, { recursive: true })
    this.standaloneRoot = await realpath(this.standaloneRoot)
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'))
      if (
        data.version !== 1 ||
        !Array.isArray(data.projects) ||
        data.projects.some(
          (item: DesktopProject) =>
            !item ||
            typeof item.cwd !== 'string' ||
            !path.isAbsolute(item.cwd) ||
            typeof item.name !== 'string' ||
            typeof item.lastSelectedAt !== 'string',
        )
      )
        throw new Error('项目文件格式无效')
      this.projects = data.projects
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT')
        this.loadError = new Error(`无法读取项目文件 ${this.file}：${String(cause)}`)
    }
  }

  kind(cwd: string): WorkspaceKind {
    const relative = path.relative(this.standaloneRoot, cwd)
    return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
      ? 'standalone'
      : 'project'
  }

  isStandaloneDirectory(cwd: string) {
    return (
      path.dirname(cwd) === this.standaloneRoot &&
      /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(path.basename(cwd))
    )
  }

  async createStandaloneDirectory() {
    const cwd = path.join(this.standaloneRoot, randomUUID())
    await mkdir(cwd)
    return cwd
  }

  async validateDirectory(cwd: string) {
    if (!path.isAbsolute(cwd)) throw new Error('项目目录必须是绝对路径')
    try {
      const resolved = await realpath(cwd)
      if (!(await stat(resolved)).isDirectory()) throw new Error('所选路径不是文件夹')
      return resolved
    } catch (cause) {
      throw new Error(`目录不可用：${cwd}；${String(cause)}`)
    }
  }

  async register(cwd: string) {
    const resolved = await this.validateDirectory(cwd)
    if (this.kind(resolved) === 'standalone') throw new Error('不能将无项目会话目录登记为项目')
    const project = {
      cwd: resolved,
      name: this.projects.find((item) => item.cwd === resolved)?.name ?? (path.basename(resolved) || resolved),
      lastSelectedAt: new Date().toISOString(),
    }
    const save = this.saving
      .catch(() => {})
      .then(async () => {
        if (this.loadError) throw this.loadError
        project.name = this.projects.find((item) => item.cwd === resolved)?.name ?? project.name
        const projects = [project, ...this.projects.filter((item) => item.cwd !== resolved)]
        const temporary = `${this.file}.tmp`
        await writeFile(temporary, JSON.stringify({ version: 1, projects }), 'utf8')
        await rename(temporary, this.file)
        this.projects = projects
      })
    this.saving = save
    try {
      await save
    } catch (cause) {
      throw new Error(`无法保存项目文件 ${this.file}：${String(cause)}`)
    }
    return project
  }

  private update(change: (projects: DesktopProject[]) => DesktopProject[]) {
    const save = this.saving
      .catch(() => {})
      .then(async () => {
        if (this.loadError) throw this.loadError
        const projects = change(this.projects)
        await writeFile(`${this.file}.tmp`, JSON.stringify({ version: 1, projects }), 'utf8')
        await rename(`${this.file}.tmp`, this.file)
        this.projects = projects
      })
    this.saving = save
    return save
  }

  async renameProject(cwd: string, name: string) {
    const normalized = await realpath(cwd).catch(() => cwd)
    await this.update((projects) => {
      const existing = projects.find((item) => item.cwd === normalized)
      return [
        { ...(existing ?? { cwd: normalized, lastSelectedAt: '' }), name },
        ...projects.filter((item) => item.cwd !== normalized),
      ]
    })
  }

  async remove(cwd: string) {
    await this.update((projects) => projects.filter((item) => item.cwd !== cwd))
  }

  async list(cwds: string[] = []) {
    if (this.loadError) throw this.loadError
    const projects = new Map<string, DesktopProject>()
    for (const item of [...this.projects].sort((a, b) => b.lastSelectedAt.localeCompare(a.lastSelectedAt))) {
      let cwd = item.cwd
      let unavailable = false
      try {
        cwd = await this.validateDirectory(cwd)
      } catch {
        unavailable = true
      }
      if (this.kind(cwd) === 'project' && !projects.has(cwd)) projects.set(cwd, { ...item, cwd, unavailable })
    }
    for (const original of cwds) {
      if (!original || !path.isAbsolute(original)) continue
      let cwd = original
      let unavailable = false
      try {
        cwd = await this.validateDirectory(cwd)
      } catch {
        unavailable = true
      }
      if (this.kind(cwd) === 'project' && !projects.has(cwd))
        projects.set(cwd, { cwd, name: path.basename(cwd) || cwd, lastSelectedAt: '', unavailable })
    }
    return [...projects.values()]
  }
}
