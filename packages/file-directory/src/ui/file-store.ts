import type { AppHostCapabilities, FileEntry, FilePreview, HostApi, WorkspaceRef } from '@pi-meme/contracts/app-host'

export type FileState = {
  root: WorkspaceRef
  entries: Record<string, FileEntry[]>
  expanded: string[]
  treeHidden: boolean
  selected: string
  preview?: FilePreview
  draft: string
  saved: string
  loading: boolean
  saving: boolean
  error: string
  loadId: number
  query: string
  matches: FileEntry[]
  nextCursor?: string
  searching: boolean
}
const rootKey = (root: WorkspaceRef) => JSON.stringify(root)
export const fileDirty = (state: FileState) => state.preview?.kind === 'text' && state.draft !== state.saved

export class FileStore {
  private readonly states = new Map<string, FileState>()
  private readonly listeners = new Set<() => void>()
  private readonly requests = new Map<string, number>()
  private readonly directories = new Map<string, Promise<void>>()
  private disposed = false
  capabilities?: AppHostCapabilities
  private readonly ready: Promise<void>
  constructor(readonly host: HostApi) {
    this.ready = host
      .capabilities()
      .then((value) => {
        this.capabilities = value
        for (const state of this.states.values()) this.update(state.root, {})
      })
      .catch(() => {})
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  state(root: WorkspaceRef): FileState {
    const id = rootKey(root)
    let value = this.states.get(id)
    if (!value) {
      value = {
        root,
        entries: {},
        expanded: [],
        treeHidden: false,
        selected: '',
        draft: '',
        saved: '',
        loading: false,
        saving: false,
        error: '',
        loadId: 0,
        query: '',
        matches: [],
        searching: false,
      }
      this.states.set(id, value)
    }
    return value
  }
  update(root: WorkspaceRef, value: Partial<FileState>) {
    if (this.disposed) return
    this.states.set(rootKey(root), { ...this.state(root), ...value })
    for (const listener of this.listeners) listener()
  }
  private request(key: string) {
    const id = (this.requests.get(key) ?? 0) + 1
    this.requests.set(key, id)
    return () => !this.disposed && this.requests.get(key) === id
  }
  canWrite(state: FileState) {
    return (
      state.preview?.kind === 'text' &&
      Boolean(state.preview.revision) &&
      Boolean(this.capabilities?.fileOperations?.includes('write'))
    )
  }
  hasDirty() {
    return [...this.states.values()].some(fileDirty)
  }
  async loadDirectory(root: WorkspaceRef, path = '') {
    const key = `${rootKey(root)}:directory:${path}`
    if (this.state(root).entries[path]) return
    if (this.directories.has(key)) return this.directories.get(key)
    const current = this.request(key)
    const pending = this.host.files
      .list(root, path)
      .then((entries) => {
        if (current()) this.update(root, { entries: { ...this.state(root).entries, [path]: entries } })
      })
      .catch((cause) => {
        if (current()) this.update(root, { error: String(cause) })
      })
      .finally(() => {
        if (this.directories.get(key) === pending) this.directories.delete(key)
      })
    this.directories.set(key, pending)
    return pending
  }
  async refresh(root: WorkspaceRef) {
    for (const key of this.requests.keys()) if (key.startsWith(`${rootKey(root)}:directory:`)) this.request(key)
    for (const key of this.directories.keys())
      if (key.startsWith(`${rootKey(root)}:directory:`)) this.directories.delete(key)
    this.update(root, { entries: {}, error: '' })
    await this.loadDirectory(root)
  }
  toggleDirectory(root: WorkspaceRef, path: string) {
    const expanded = this.state(root).expanded
    this.update(root, {
      expanded: expanded.includes(path) ? expanded.filter((entry) => entry !== path) : [...expanded, path],
    })
  }
  edit(root: WorkspaceRef, draft: string) {
    this.update(root, { draft })
  }
  async select(root: WorkspaceRef, path: string) {
    const current = this.request(`${rootKey(root)}:file`)
    this.update(root, { selected: path, preview: undefined, draft: '', saved: '', loading: true, error: '' })
    try {
      await this.ready
      const preview: FilePreview = this.capabilities?.fileOperations?.includes('preview')
        ? await this.host.files.preview(root, path)
        : { ...(await this.host.files.read(root, path)), kind: 'text', revision: '' }
      if (current())
        this.update(root, {
          preview,
          draft: preview.kind === 'text' ? preview.content.replace(/\r\n/g, '\n') : '',
          saved: preview.kind === 'text' ? preview.content.replace(/\r\n/g, '\n') : '',
          loadId: this.state(root).loadId + 1,
        })
    } catch (cause) {
      if (current()) this.update(root, { error: String(cause) })
    } finally {
      if (current()) this.update(root, { loading: false })
    }
  }
  async save(root: WorkspaceRef): Promise<boolean> {
    const state = this.state(root)
    if (state.saving || !this.canWrite(state) || state.preview?.kind !== 'text') return false
    if (!fileDirty(state)) return true
    const input = { relativePath: state.selected, content: state.draft, revision: state.preview.revision }
    const loadId = state.loadId
    this.update(root, { saving: true, error: '' })
    try {
      const result = await this.host.files.write(root, input, { idempotencyKey: crypto.randomUUID() })
      const next = this.state(root)
      if (next.selected === input.relativePath && next.loadId === loadId)
        this.update(root, {
          saved: input.content,
          preview: {
            kind: 'text',
            relativePath: input.relativePath,
            content: input.content,
            revision: result.revision,
          },
        })
      return true
    } catch (cause) {
      this.update(root, { error: String(cause) })
      return false
    } finally {
      this.update(root, { saving: false })
    }
  }
  async search(root: WorkspaceRef, query: string, more = false) {
    const current = this.request(`${rootKey(root)}:search`)
    const previous = this.state(root)
    this.update(root, {
      query,
      searching: Boolean(query.trim()),
      matches: more ? previous.matches : [],
      nextCursor: more ? previous.nextCursor : undefined,
      error: '',
    })
    if (!query.trim()) return
    try {
      await this.ready
      if (!this.capabilities?.fileOperations?.includes('search')) return
      const result = await this.host.files.search(root, { query, cursor: more ? previous.nextCursor : undefined })
      if (current())
        this.update(root, {
          matches: [...(more ? previous.matches : []), ...result.entries],
          nextCursor: result.nextCursor,
        })
    } catch (cause) {
      if (current()) this.update(root, { error: String(cause) })
    } finally {
      if (current()) this.update(root, { searching: false })
    }
  }
  dispose() {
    this.disposed = true
    this.listeners.clear()
  }
}
