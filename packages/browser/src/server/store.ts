import { mkdir, readFile, readdir, rename, writeFile, rm } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import type {
  BrowserAnnotation,
  BrowserDownload,
  BrowserPermission,
  BrowserSettings,
  BrowserSnapshot,
  BrowserWorkspace,
} from '@pi-meme/contracts/browser'
import { validAnnotation } from '../shared/annotations'

const defaults: BrowserSettings = {
  links: 'external',
  localLinks: 'internal',
  search: 'bing',
  fullUrl: false,
  screenshots: 'element',
  restore: true,
  downloadDirectory: '',
  askDownload: true,
}
const empty = (): BrowserSnapshot => ({ settings: { ...defaults }, permissions: [], history: [], downloads: [] })
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
type SavedAnnotation = Omit<BrowserAnnotation, 'image'> & { asset?: string }
type SavedWorkspace = Omit<BrowserWorkspace, 'annotations' | 'editor'> & {
  annotations: SavedAnnotation[]
  editor?: SavedAnnotation
}

export class BrowserStore {
  private state = empty()
  private pending: Promise<unknown> = Promise.resolve()
  constructor(private readonly directory: string) {}
  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    try {
      const saved = JSON.parse(await readFile(path.join(this.directory, 'state.json'), 'utf8')) as BrowserSnapshot
      if (
        !saved ||
        !Array.isArray(saved.permissions) ||
        !Array.isArray(saved.history) ||
        !Array.isArray(saved.downloads)
      )
        throw new Error('浏览器存档结构无效')
      this.state = {
        ...saved,
        settings: { ...defaults, ...saved.settings },
        downloads: saved.downloads.map((item) =>
          item.state === 'progressing' ? { ...item, state: 'interrupted' } : item,
        ),
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    }
  }
  snapshot() {
    return structuredClone(this.state)
  }
  private serialize<T>(action: () => Promise<T>) {
    const result = this.pending.then(action)
    this.pending = result.catch(() => {})
    return result
  }
  private async write(file: string, value: unknown) {
    const target = path.join(this.directory, file)
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600 })
      await rename(temporary, target)
    } finally {
      await rm(temporary, { force: true })
    }
  }
  private change(action: (state: BrowserSnapshot) => void) {
    return this.serialize(async () => {
      const next = this.snapshot()
      action(next)
      await this.write('state.json', next)
      this.state = next
      return this.snapshot()
    })
  }
  settings(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('浏览器设置无效')
    const patch = value as Partial<BrowserSettings>
    for (const [key, item] of Object.entries(patch)) {
      if (!Object.hasOwn(defaults, key)) throw new Error('未知浏览器设置')
      const choices: Record<string, string[]> = {
        links: ['internal', 'external'],
        localLinks: ['internal', 'external'],
        search: ['bing', 'google', 'duckduckgo'],
        screenshots: ['element', 'viewport', 'none'],
      }
      if (
        choices[key]
          ? !choices[key].includes(String(item))
          : key === 'downloadDirectory'
            ? typeof item !== 'string' || (item !== '' && !path.isAbsolute(item))
            : typeof item !== 'boolean'
      )
        throw new Error('浏览器设置值无效')
    }
    return this.change((state) => {
      Object.assign(state.settings, patch)
    })
  }
  permission(value: unknown) {
    const item = value as BrowserPermission
    if (
      !item ||
      new URL(item.origin).origin !== item.origin ||
      !['http:', 'https:'].includes(new URL(item.origin).protocol) ||
      ![
        'media',
        'geolocation',
        'clipboard-read',
        'notifications',
        'display-capture',
        'midi',
        'pointerLock',
        'fullscreen',
      ].includes(item.permission) ||
      !['ask', 'allow', 'deny'].includes(item.value)
    )
      throw new Error('网站权限无效')
    return this.change((state) => {
      state.permissions = state.permissions.filter((p) => p.origin !== item.origin || p.permission !== item.permission)
      if (item.value !== 'ask') state.permissions.push(item)
    })
  }
  history(value?: unknown) {
    return this.change((state) => {
      if (typeof value === 'string') state.history = state.history.filter((item) => item.id !== value)
      else if (value && typeof value === 'object') {
        const item = value as BrowserSnapshot['history'][number]
        if (!item.id || !/^https?:\/\//.test(item.url) || typeof item.title !== 'string')
          throw new Error('浏览记录无效')
        state.history = [item, ...state.history.filter((previous) => previous.url !== item.url)].slice(0, 2000)
      } else state.history = []
    })
  }
  download(value: BrowserDownload | string) {
    return this.change((state) => {
      state.downloads =
        typeof value === 'string'
          ? state.downloads.filter((item) => item.id !== value)
          : [value, ...state.downloads.filter((item) => item.id !== value.id)].slice(0, 500)
    })
  }
  clearDownloads() {
    return this.change((state) => {
      state.downloads = state.downloads.filter((item) => item.state === 'progressing')
    })
  }
  private workspaceFile(owner: string) {
    if (!owner || owner.length > 2048) throw new Error('浏览器草稿目标无效')
    return `workspace-${digest(owner)}.json`
  }
  private async saveAnnotation(value: BrowserAnnotation): Promise<SavedAnnotation> {
    if (!validAnnotation(value)) throw new Error('网页批注无效或内容过大')
    const { image, ...record } = value
    if (!image) return record
    const bytes = Buffer.from(image.data, 'base64')
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      throw new Error('批注截图必须是 PNG')
    const asset = digest(image.data)
    await writeFile(path.join(this.directory, `${asset}.png`), bytes, { mode: 0o600, flag: 'wx' }).catch((cause) => {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause
    })
    return { ...record, asset }
  }
  private async loadAnnotation({ asset, ...value }: SavedAnnotation): Promise<BrowserAnnotation> {
    if (!asset) return value
    if (!/^[a-f0-9]{64}$/.test(asset)) throw new Error('批注图片引用无效')
    return {
      ...value,
      image: {
        type: 'image',
        mimeType: 'image/png',
        data: (await readFile(path.join(this.directory, `${asset}.png`))).toString('base64'),
      },
    }
  }
  async workspace(owner: string): Promise<BrowserWorkspace> {
    await this.pending
    try {
      const saved = JSON.parse(
        await readFile(path.join(this.directory, this.workspaceFile(owner)), 'utf8'),
      ) as SavedWorkspace
      return {
        tabs: saved.tabs
          .filter((tab) => tab.owner === owner)
          .map((tab) => ({ ...tab, loading: false, canGoBack: false, canGoForward: false })),
        annotations: await Promise.all(saved.annotations.map((item) => this.loadAnnotation(item))),
        ...(saved.editor ? { editor: await this.loadAnnotation(saved.editor) } : {}),
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
      return { tabs: [], annotations: [] }
    }
  }
  saveWorkspace(owner: string, value: BrowserWorkspace) {
    return this.serialize(async () => {
      const file = this.workspaceFile(owner)
      if (
        !value ||
        !Array.isArray(value.tabs) ||
        !Array.isArray(value.annotations) ||
        value.tabs.length > 32 ||
        value.annotations.length > 100
      )
        throw new Error('浏览器工作区无效或超出数量限制')
      for (const tab of value.tabs) {
        if (
          tab.owner !== owner ||
          !/^[a-zA-Z0-9-]{1,128}$/.test(tab.id) ||
          typeof tab.url !== 'string' ||
          (tab.url !== 'about:blank' && !/^https?:\/\//.test(tab.url))
        )
          throw new Error('网页标签目标无效')
      }
      const saved: SavedWorkspace = {
        tabs: value.tabs,
        annotations: await Promise.all(value.annotations.map((item) => this.saveAnnotation(item))),
        ...(value.editor ? { editor: await this.saveAnnotation(value.editor) } : {}),
      }
      await this.write(file, saved)
      await this.collectAssets()
    })
  }
  private async collectAssets() {
    const files = await readdir(this.directory)
    const used = new Set<string>()
    for (const file of files.filter((name) => /^workspace-[a-f0-9]{64}\.json$/.test(name))) {
      const value = JSON.parse(await readFile(path.join(this.directory, file), 'utf8')) as SavedWorkspace
      for (const annotation of [...value.annotations, ...(value.editor ? [value.editor] : [])])
        if (annotation.asset) used.add(annotation.asset)
    }
    for (const file of files)
      if (/^[a-f0-9]{64}\.png$/.test(file) && !used.has(file.slice(0, -4))) await rm(path.join(this.directory, file))
  }
  async rebind(from: string, to: string) {
    if (from === to) return
    const previous = await this.workspace(from)
    const current = await this.workspace(to)
    await this.saveWorkspace(to, {
      tabs: [...current.tabs, ...previous.tabs.map((tab) => ({ ...tab, owner: to }))].filter(
        (tab, index, all) => all.findIndex((item) => item.id === tab.id) === index,
      ),
      annotations: [...current.annotations, ...previous.annotations].filter(
        (item, index, all) => all.findIndex((other) => other.id === item.id) === index,
      ),
      editor: current.editor ?? previous.editor,
    })
    await this.serialize(() => rm(path.join(this.directory, this.workspaceFile(from)), { force: true }))
  }
}
