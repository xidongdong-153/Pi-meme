import { constants } from 'node:fs'
import { mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { maxImagePreviewBytes } from '@pi-meme/contracts/app-host'
import type { ImageArtifact } from '@pi-meme/contracts/image-generation'
import type { ImageLibraryItem, ImageLibraryPage, ImageLibraryQuery } from '@pi-meme/contracts/image-library'

type RecordItem = ImageLibraryItem & { path: string; removed?: boolean }
export type ImageLibraryCandidate = Pick<
  ImageLibraryItem,
  'prompt' | 'createdAt' | 'session' | 'project' | 'projectName'
> & {
  artifact: ImageArtifact
}
export type ImageLibraryHistory = {
  key: string
  revision: string
  read: () => Promise<ImageLibraryCandidate[]>
}
type State = { version: 1; records: RecordItem[]; scanned: Record<string, { revision: string; skipped: number }> }
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

export class ImageLibraryStore {
  private state: State = { version: 1, records: [], scanned: {} }
  private ready?: Promise<void>
  private queue: Promise<unknown> = Promise.resolve()
  private scanning?: Promise<void>
  private lastScan = 0
  private closing = false
  private scan: ImageLibraryPage['scan'] = { running: false, completed: 0, total: 0, skipped: 0 }

  constructor(
    private readonly options: {
      hostId: string
      file: string
      attachments: string
      history: () => Promise<ImageLibraryHistory[]>
      onChange: () => void
    },
  ) {}

  private init() {
    return (this.ready ??= (async () => {
      try {
        const state = JSON.parse(await readFile(this.options.file, 'utf8')) as State
        if (
          state.version !== 1 ||
          !Array.isArray(state.records) ||
          !state.scanned ||
          state.records.some(
            (item) =>
              !item ||
              typeof item.id !== 'string' ||
              typeof item.path !== 'string' ||
              typeof item.name !== 'string' ||
              typeof item.prompt !== 'string' ||
              !item.session ||
              typeof item.session.sessionId !== 'string' ||
              item.session.hostId !== this.options.hostId ||
              !Number.isFinite(item.width) ||
              item.width <= 0 ||
              !Number.isFinite(item.height) ||
              item.height <= 0 ||
              typeof item.model !== 'string' ||
              !['generate', 'edit'].includes(item.operation) ||
              item.hostId !== this.options.hostId ||
              !Number.isFinite(Date.parse(item.createdAt)),
          )
        )
          throw new Error('图像索引格式无效')
        if (
          typeof state.scanned !== 'object' ||
          Array.isArray(state.scanned) ||
          Object.values(state.scanned).some(
            (entry) =>
              !entry || typeof entry.revision !== 'string' || !Number.isInteger(entry.skipped) || entry.skipped < 0,
          ) ||
          new Set(state.records.map((item) => item.id)).size !== state.records.length
        )
          throw new Error('图像索引格式无效')
        this.state = state
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT')
          throw new Error('无法读取图像索引，原文件已保留', { cause })
      }
    })())
  }

  private change(action: () => void) {
    const job = this.queue.then(async () => {
      await this.init()
      const previous = structuredClone(this.state)
      const temporary = `${this.options.file}.${randomUUID()}.tmp`
      try {
        action()
        await mkdir(path.dirname(this.options.file), { recursive: true, mode: 0o700 })
        await writeFile(temporary, JSON.stringify(this.state), { mode: 0o600, flag: 'wx' })
        await rename(temporary, this.options.file)
      } catch (cause) {
        this.state = previous
        throw cause
      } finally {
        await rm(temporary, { force: true })
      }
    })
    this.queue = job.catch(() => {})
    return job
  }

  private async bytes(file: string) {
    const root = path.resolve(this.options.attachments)
    const resolved = path.resolve(file)
    if (
      !resolved.startsWith(`${root}${path.sep}`) ||
      (await realpath(root)) !== root ||
      (await realpath(resolved)) !== resolved
    )
      throw new Error('图片路径不在附件目录内，或包含符号链接')
    const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > maxImagePreviewBytes) throw new Error('图片文件无效或超过 8 MiB')
      const buffer = Buffer.alloc(info.size + 1)
      let length = 0
      while (length < buffer.length) {
        const result = await handle.read(buffer, length, buffer.length - length, null)
        if (!result.bytesRead) break
        length += result.bytesRead
      }
      const bytes = buffer.subarray(0, length)
      if (
        length !== info.size ||
        bytes.length < 33 ||
        !bytes.subarray(0, 8).equals(signature) ||
        bytes.toString('ascii', 12, 16) !== 'IHDR'
      )
        throw new Error('图片文件损坏或读取期间发生变化')
      const width = bytes.readUInt32BE(16)
      const height = bytes.readUInt32BE(20)
      if (!width || !height) throw new Error('图片尺寸无效')
      return { bytes, width, height }
    } finally {
      await handle.close()
    }
  }

  async add(candidate: ImageLibraryCandidate) {
    await this.init()
    const { artifact, prompt, createdAt, session, project, projectName } = candidate
    if (this.state.records.some((item) => item.id === artifact.id)) return
    if (
      !artifact.id ||
      typeof prompt !== 'string' ||
      !Number.isFinite(Date.parse(createdAt)) ||
      session.hostId !== this.options.hostId
    )
      throw new Error('图像来源无效')
    const { width, height } = await this.bytes(artifact.path)
    await this.change(() => {
      if (this.state.records.some((item) => item.id === artifact.id)) return
      this.state.records.push({
        id: artifact.id,
        hostId: this.options.hostId,
        path: artifact.path,
        name: Array.from(prompt.split(/\r?\n/)[0].trim()).slice(0, 40).join('') || `图像 · ${createdAt}`,
        prompt,
        createdAt,
        session,
        project,
        projectName,
        width,
        height,
        model: artifact.model,
        operation: artifact.operation,
      })
    })
    this.options.onChange()
  }

  private startScan() {
    if (this.closing || this.scanning || Date.now() - this.lastScan < 30_000) return
    this.lastScan = Date.now()
    this.scan = { running: true, completed: 0, total: 0, skipped: 0 }
    this.scanning = (async () => {
      const sources = await this.options.history()
      this.scan.total = sources.length
      for (const source of sources) {
        if (this.closing) break
        const previous = this.state.scanned[source.key]
        if (previous?.revision === source.revision && previous.skipped === 0) {
          this.scan.skipped += previous.skipped
          this.scan.completed++
          continue
        }
        let skipped = 0
        try {
          for (const candidate of await source.read()) {
            if (this.closing) return
            try {
              await this.add(candidate)
            } catch {
              skipped++
            }
          }
          await this.change(() => {
            this.state.scanned[source.key] = { revision: source.revision, skipped }
          })
        } catch {
          skipped++
        }
        this.scan.completed++
        this.scan.skipped += skipped
      }
    })()
      .catch((cause: unknown) => {
        this.scan.error = cause instanceof Error ? cause.message : '历史图像补录失败'
      })
      .finally(() => {
        this.scan.running = false
        this.scanning = undefined
        this.options.onChange()
      })
  }

  async list(input: ImageLibraryQuery = {}): Promise<ImageLibraryPage> {
    await this.init()
    if (
      !input ||
      (input.query !== undefined && typeof input.query !== 'string') ||
      (input.projectId !== undefined && typeof input.projectId !== 'string') ||
      (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100))
    )
      throw new Error('图像查询参数无效')
    this.startScan()
    let after: { createdAt: string; id: string } | undefined
    if (input.cursor) {
      try {
        after = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'))
        if (!after || typeof after.createdAt !== 'string' || typeof after.id !== 'string')
          throw new Error('图像分页位置无效')
      } catch {
        throw new Error('图像分页位置无效')
      }
    }
    await this.queue
    const query = input.query?.trim().toLocaleLowerCase() ?? ''
    const all = this.state.records.filter((item) => !item.removed)
    const projects = [
      ...new Map(
        all
          .filter((item) => item.project)
          .map((item) => [
            item.project!.projectId,
            {
              id: item.project!.projectId,
              name: item.projectName || '已移除的项目',
            },
          ]),
      ).values(),
    ]
    const sorted = all
      .filter(
        (item) =>
          (!input.projectId ||
            (input.projectId === 'standalone' ? !item.project : item.project?.projectId === input.projectId)) &&
          (!query || `${item.name}\n${item.prompt}`.toLocaleLowerCase().includes(query)) &&
          (!after || item.createdAt < after.createdAt || (item.createdAt === after.createdAt && item.id < after.id)),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    const limit = input.limit ?? 40
    const records = sorted.slice(0, limit)
    const last = records.at(-1)
    return {
      items: records.map(({ path: _path, removed: _removed, ...item }) => structuredClone(item)),
      projects,
      nextCursor:
        sorted.length > limit && last
          ? Buffer.from(JSON.stringify({ createdAt: last.createdAt, id: last.id })).toString('base64url')
          : undefined,
      scan: { ...this.scan },
    }
  }

  private record(id: string) {
    const item = this.state.records.find((item) => item.id === id && !item.removed)
    if (!item) throw new Error('图像不存在或已移除')
    return item
  }

  async read(id: string) {
    await this.init()
    await this.queue
    let bytes: Buffer
    try {
      ;({ bytes } = await this.bytes(this.record(id).path))
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('原图文件不存在')
      throw cause
    }
    return { dataUrl: `data:image/png;base64,${bytes.toString('base64')}`, size: bytes.length }
  }

  async rename(id: string, name: string) {
    if (
      typeof name !== 'string' ||
      !name.trim() ||
      Array.from(name.trim()).length > 120 ||
      Array.from(name).some((character) => character.charCodeAt(0) < 32)
    )
      throw new Error('图像名称需为 1～120 个字符，不能包含换行或控制字符')
    await this.change(() => {
      this.record(id).name = name.trim()
    })
    this.options.onChange()
  }

  async remove(id: string) {
    await this.change(() => {
      const item = this.state.records.find((item) => item.id === id)
      if (!item) throw new Error('图像不存在')
      item.removed = true
    })
    this.options.onChange()
  }

  async dispose() {
    this.closing = true
    await this.scanning
    await this.queue
  }
}
