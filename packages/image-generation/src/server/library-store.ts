import { constants } from 'node:fs'
import { mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { maxImagePreviewBytes } from '@pi-meme/contracts/app-host'
import type { ImageArtifact } from '@pi-meme/contracts/image-generation'
import type {
  GeneratedImageLibraryItem,
  ImageLibraryItem,
  ImageLibraryPage,
  ImageLibraryQuery,
} from '@pi-meme/contracts/image-library'
import { imageMetadata } from './image-metadata'
import { decodeLibraryState, publicLibraryItem, type LibraryState } from './library-state'

export type ImageLibraryCandidate = Pick<
  GeneratedImageLibraryItem,
  'prompt' | 'createdAt' | 'session' | 'project' | 'projectName'
> & {
  artifact: ImageArtifact
}
export type ImageLibraryHistory = {
  key: string
  revision: string
  read: () => Promise<ImageLibraryCandidate[]>
}
export class ImageLibraryStore {
  private state: LibraryState = { version: 2, records: [], scanned: Object.create(null), imports: Object.create(null) }
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
      existingSessionIds?: () => Promise<string[]>
    },
  ) {}

  private init() {
    return (this.ready ??= (async () => {
      let raw: string
      try {
        raw = await readFile(this.options.file, 'utf8')
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return
        throw new Error('无法读取图像索引，原文件已保留', { cause })
      }
      try {
        const { state, legacy } = decodeLibraryState(JSON.parse(raw), this.options.hostId)
        if (legacy) {
          const backup = `${this.options.file}.v1.bak`
          try {
            await writeFile(backup, raw, { mode: 0o600, flag: 'wx' })
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause
            if ((await readFile(backup, 'utf8')) !== raw)
              throw new Error('v1 图像索引备份与当前文件不同，请先处理备份后再升级')
          }
          await this.persist(state)
        }
        this.state = state
      } catch (cause) {
        throw new Error('无法读取或升级图像索引，原文件和已有备份已保留', { cause })
      }
    })())
  }

  private async persist(state: LibraryState) {
    const temporary = `${this.options.file}.${randomUUID()}.tmp`
    try {
      await mkdir(path.dirname(this.options.file), { recursive: true, mode: 0o700 })
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' })
      await rename(temporary, this.options.file)
    } finally {
      await rm(temporary, { force: true }).catch(() => {})
    }
  }

  private notify() {
    // A failed live event must not turn a committed upload into a failure and delete its file.
    try {
      this.options.onChange()
    } catch {
      // The next refresh reads the durable index.
    }
  }

  private change<T>(action: () => T) {
    const job = this.queue.then(async () => {
      await this.init()
      const previous = structuredClone(this.state)
      try {
        const result = action()
        await this.persist(this.state)
        return result
      } catch (cause) {
        this.state = previous
        throw cause
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
      if (!info.isFile() || info.size <= 0 || info.size > maxImagePreviewBytes)
        throw new Error('图片文件无效或超过 8 MiB')
      const buffer = Buffer.alloc(info.size + 1)
      let length = 0
      while (length < buffer.length) {
        const result = await handle.read(buffer, length, buffer.length - length, null)
        if (!result.bytesRead) break
        length += result.bytesRead
      }
      const bytes = buffer.subarray(0, length)
      const after = await handle.stat()
      if (
        length !== info.size ||
        after.size !== info.size ||
        after.mtimeMs !== info.mtimeMs ||
        after.ctimeMs !== info.ctimeMs
      )
        throw new Error('图片文件损坏或读取期间发生变化')
      return { bytes, ...imageMetadata(bytes) }
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
    const { width, height, mimeType } = await this.bytes(artifact.path)
    if (mimeType !== 'image/png' || artifact.mimeType !== 'image/png') throw new Error('生成图像必须是 PNG')
    await this.change(() => {
      if (this.state.records.some((item) => item.id === artifact.id)) return
      this.state.records.push({
        id: artifact.id,
        hostId: this.options.hostId,
        origin: 'generated',
        mimeType: 'image/png',
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
    this.notify()
  }

  async importFile(
    file: string,
    name?: string,
    idempotencyKey?: string,
  ): Promise<{ item: ImageLibraryItem; created: boolean }> {
    if (typeof file !== 'string' || !file || (name !== undefined && typeof name !== 'string'))
      throw new Error('导入图片路径或名称无效')
    if (
      idempotencyKey !== undefined &&
      (typeof idempotencyKey !== 'string' || !idempotencyKey || idempotencyKey.length > 256)
    )
      throw new Error('图片导入幂等键无效')
    const displayName = this.validName(name ?? path.basename(file))
    const key = idempotencyKey === undefined ? undefined : createHash('sha256').update(idempotencyKey).digest('hex')
    await this.init()
    const { bytes, mimeType, width, height } = await this.bytes(file)
    const digest = createHash('sha256').update(bytes).digest('hex')
    const result = await this.change(() => {
      const previous = key ? this.state.imports[key] : undefined
      if (previous) {
        if (previous.digest !== digest || previous.name !== displayName)
          throw new Error('图片导入幂等键已用于不同内容或名称')
        return { item: publicLibraryItem(this.record(previous.id)), created: false }
      }
      const item: LibraryState['records'][number] = {
        id: randomUUID(),
        hostId: this.options.hostId,
        origin: 'uploaded',
        path: path.resolve(file),
        name: displayName,
        createdAt: new Date().toISOString(),
        mimeType,
        width,
        height,
      }
      this.state.records.push(item)
      if (key) this.state.imports[key] = { id: item.id, digest, name: displayName }
      return { item: publicLibraryItem(item), created: true }
    })
    if (result.created) this.notify()
    return result
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
        this.notify()
      })
  }

  async list(input: ImageLibraryQuery = {}): Promise<ImageLibraryPage> {
    await this.init()
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      (input.origin !== undefined && !['all', 'generated', 'uploaded'].includes(input.origin)) ||
      (input.cursor !== undefined && typeof input.cursor !== 'string') ||
      (input.query !== undefined && typeof input.query !== 'string') ||
      (input.projectId !== undefined && typeof input.projectId !== 'string') ||
      (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100))
    )
      throw new Error('图像查询参数无效')
    if (this.options.existingSessionIds) {
      const existing = new Set(await this.options.existingSessionIds())
      const detached = this.state.records.filter(
        (item): item is GeneratedImageLibraryItem & { path: string; removed?: boolean } =>
          item.origin === 'generated' && !item.sourceStatus && !existing.has(item.session.sessionId),
      )
      if (detached.length) await this.detachSessions(detached.map((item) => item.session.sessionId))
    }
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
    const origin = input.origin ?? 'generated'
    const all = this.state.records.filter((item) => !item.removed && (origin === 'all' || item.origin === origin))
    const projects = [
      ...new Map(
        all
          .filter(
            (item): item is GeneratedImageLibraryItem & { path: string; removed?: boolean } =>
              item.origin === 'generated' && Boolean(item.project),
          )
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
            (item.origin === 'generated' &&
              (input.projectId === 'standalone' ? !item.project : item.project?.projectId === input.projectId))) &&
          (!query ||
            `${item.name}\n${item.origin === 'generated' ? item.prompt : ''}`.toLocaleLowerCase().includes(query)) &&
          (!after || item.createdAt < after.createdAt || (item.createdAt === after.createdAt && item.id < after.id)),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    const limit = input.limit ?? 40
    const records = sorted.slice(0, limit)
    const last = records.at(-1)
    return {
      items: records.map(publicLibraryItem),
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

  async get(id: string): Promise<ImageLibraryItem> {
    await this.init()
    await this.queue
    return publicLibraryItem(this.record(id))
  }

  async read(id: string) {
    await this.init()
    await this.queue
    const item = this.record(id)
    try {
      const { bytes, mimeType, width, height } = await this.bytes(item.path)
      if (mimeType !== item.mimeType || width !== item.width || height !== item.height)
        throw new Error('原图格式或尺寸已变化，请重新导入')
      return { dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}`, size: bytes.length }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('原图文件不存在')
      throw cause
    }
  }

  private validName(name: string) {
    if (
      typeof name !== 'string' ||
      !name.trim() ||
      Array.from(name.trim()).length > 120 ||
      Array.from(name).some((character) => character.charCodeAt(0) < 32)
    )
      throw new Error('图像名称需为 1～120 个字符，不能包含换行或控制字符')
    return name.trim()
  }

  async rename(id: string, name: string) {
    const normalized = this.validName(name)
    await this.change(() => {
      this.record(id).name = normalized
    })
    this.notify()
  }

  async remove(id: string) {
    await this.change(() => {
      const item = this.state.records.find((item) => item.id === id)
      if (!item) throw new Error('图像不存在')
      item.removed = true
    })
    this.notify()
  }

  async detachSessions(sessionIds: string[]) {
    const ids = new Set(sessionIds)
    await this.change(() => {
      for (const item of this.state.records)
        if (item.origin === 'generated' && ids.has(item.session.sessionId)) item.sourceStatus = 'detached'
    })
    this.notify()
  }

  async dispose() {
    this.closing = true
    await this.scanning
    await this.queue
  }
}
