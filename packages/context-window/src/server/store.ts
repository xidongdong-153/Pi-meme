import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { gzip, gunzip } from 'node:zlib'
import { promisify } from 'node:util'
import {
  contextCaptureLimits as limits,
  contextPartKinds,
  type ContextCapture,
  type ContextRequest,
  type ContextRequestPage,
  type ContextListQuery,
  type ContextItemQuery,
  type ContextItemPage,
  type ContextPieceQuery,
  type ContextPiecePage,
  type ContextPiece,
  type ContextReplyPage,
  type ContextBodyState,
} from '@pi-meme/contracts/context-window'
import { promptItems, inspectPrompt, scalePromptItems, calibratePrompt } from '../shared/prompt'

const compress = promisify(gzip)
const decompress = promisify(gunzip)
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const missing = (cause: unknown) => (cause as NodeJS.ErrnoException).code === 'ENOENT'
type Body = { body?: string; reply?: ContextPiece[]; revision: number; bytes: number; fingerprint?: string }
type Session = { directory: string; temporary: boolean; records: Map<string, ContextRequest>; loaded?: Promise<void> }
type StoredBody = { version: 1; body?: string; reply?: ContextPiece[]; revision: number }

/** Host-owned observational data. Full bodies never enter the conversation or the control journal. */
export class ContextWindowStore {
  private sessions = new Map<string, Session>()
  private bodies = new Map<string, Body>()
  private deleted = new Set<string>()
  private writes = new Map<string, Promise<void>>()
  private maintenance: Promise<void> = Promise.resolve()
  private updates = 0

  constructor(
    private directory: string,
    private archiveEnabled: () => boolean = () => false,
  ) {}

  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await this.prune()
  }

  registerSession(sessionId: string, temporaryRoot?: string) {
    if (this.deleted.has(sessionId)) return
    const directory = path.join(
      temporaryRoot ? path.join(temporaryRoot, 'context-window') : this.directory,
      hash(sessionId),
    )
    const previous = this.sessions.get(sessionId)
    if (previous) {
      if (temporaryRoot && !previous.temporary) {
        if (previous.records.size || this.writes.has(sessionId)) throw new Error('上下文会话存储作用域不一致')
        previous.directory = directory
        previous.temporary = true
        previous.loaded = undefined
      } else if (temporaryRoot && previous.directory !== directory) throw new Error('临时会话存储作用域不一致')
      return
    }
    this.sessions.set(sessionId, {
      directory,
      temporary: Boolean(temporaryRoot),
      records: new Map(),
    })
  }

  private async session(sessionId: string) {
    if (!sessionId || this.deleted.has(sessionId)) throw new Error('会话已删除或不存在')
    this.registerSession(sessionId)
    const session = this.sessions.get(sessionId)!
    session.loaded ??= (async () => {
      const files = await readdir(session.directory).catch((cause: unknown) => {
        if (missing(cause)) return []
        throw cause
      })
      const cutoff = Date.now() - limits.days * 86400_000
      for (const file of files) {
        if (!/^[a-f0-9]{64}\.json$/.test(file)) continue
        let value: ContextRequest
        try {
          const metadata = path.join(session.directory, file)
          if ((await stat(metadata)).size > 1024 * 1024) continue
          value = JSON.parse(await readFile(metadata, 'utf8')) as ContextRequest
          if (
            !value ||
            typeof value.id !== 'string' ||
            `${hash(value.id)}.json` !== file ||
            !Number.isSafeInteger(value.sequence) ||
            !Number.isSafeInteger(value.revision) ||
            !Number.isFinite(Date.parse(value.time)) ||
            Date.parse(value.time) < cutoff ||
            typeof value.api !== 'string' ||
            typeof value.model !== 'string' ||
            !['main', 'summary', 'cache_warm', 'hint', 'unknown'].includes(value.purpose) ||
            !['payload', 'complete', 'failed', 'aborted'].includes(value.phase) ||
            (value.prompt && !validPrompt(value.prompt))
          )
            continue
        } catch {
          continue
        }
        value.payloadRevision ??= Math.floor(value.revision / 1_000_000)
        if (!Number.isSafeInteger(value.payloadRevision) || value.payloadRevision < 0) continue
        if (!value.done) {
          value.done = true
          value.phase = 'aborted'
          value.error = '上次运行在请求完成前结束'
        }
        value.bodyState = value.bodyState === 'archive' ? 'archive' : 'off'
        value.replyState = value.replyState === 'archive' ? 'archive' : 'off'
        session.records.set(value.id, value)
      }
    })()
    await session.loaded
    if (this.deleted.has(sessionId)) throw new Error('会话已删除')
    return session
  }

  private key(sessionId: string, id: string) {
    return JSON.stringify([sessionId, id])
  }

  async capture(sessionId: string, event: ContextCapture) {
    if (this.deleted.has(sessionId)) return
    const session = await this.session(sessionId)
    if (this.deleted.has(sessionId)) return
    const previous = session.records.get(event.id)
    if (previous && event.payloadRevision < previous.payloadRevision) return
    const key = this.key(sessionId, event.id)
    let body = this.bodies.get(key)
    const samePayload = previous?.payloadRevision === event.payloadRevision
    if (body && body.revision !== event.payloadRevision) {
      body = undefined
      this.bodies.delete(key)
    }
    if (event.phase === 'payload') {
      // A new logical payload replaces the whole snapshot, including unreadable/oversize replacements.
      if (body?.revision !== event.payloadRevision || !event.body) {
        body = undefined
        this.bodies.delete(key)
      }
      if (event.body && Buffer.byteLength(event.body) <= limits.bodyBytes) {
        const fingerprint = hash(event.body)
        if (body?.fingerprint !== fingerprint)
          body = {
            body: event.body,
            bytes: Buffer.byteLength(event.body),
            revision: event.payloadRevision,
            fingerprint,
          }
      }
    }
    let replyCut = samePayload ? (previous?.replyCut ?? false) : false
    let replyState =
      (samePayload ? previous?.replyState : undefined) ?? (event.phase === 'payload' ? 'pending' : 'missing')
    if (event.phase !== 'payload' && replyState === 'pending' && !event.reply) replyState = 'missing'
    if (event.reply) {
      const reply = event.reply.map((piece) => ({ ...piece }))
      let remaining = limits.bodyBytes - 2
      let cut = event.replyCut === true
      const kept: ContextPiece[] = []
      for (const piece of reply) {
        const bytes = Buffer.byteLength(JSON.stringify(piece)) + 1
        if (bytes > remaining) {
          if (piece.text && remaining > 1024) {
            let end = Math.min(piece.text.length, remaining - 1024)
            const original = piece.text
            piece.text = original.slice(0, end)
            while (end > 0 && Buffer.byteLength(JSON.stringify(piece)) + 1 > remaining) {
              end = Math.floor(end * 0.75)
              piece.text = original.slice(0, end)
            }
            if (/[\uD800-\uDBFF]$/.test(piece.text)) piece.text = piece.text.slice(0, -1)
            if (end > 0) kept.push(piece)
          }
          cut = true
          break
        }
        kept.push(piece)
        remaining -= bytes
      }
      body ??= { revision: event.payloadRevision, bytes: 0 }
      body.reply = kept
      body.bytes = Buffer.byteLength(body.body ?? '') + Buffer.byteLength(JSON.stringify(kept))
      replyCut = cut
      replyState = 'memory'
    }
    if (body) {
      this.bodies.delete(key)
      this.bodies.set(key, body)
      this.trimBodies()
    }
    const prompt =
      event.phase === 'payload' ? event.prompt : (event.prompt ?? (samePayload ? previous?.prompt : undefined))
    const counted = event.usage ? event.usage.input + event.usage.cacheRead + event.usage.cacheWrite : 0
    const record: ContextRequest = {
      id: event.id,
      revision: (previous?.revision ?? 0) + 1,
      payloadRevision: event.payloadRevision,
      sequence:
        previous?.sequence ?? [...session.records.values()].reduce((max, item) => Math.max(max, item.sequence), 0) + 1,
      time: previous?.time ?? event.time,
      generation: event.generation,
      nativeSessionId: event.nativeSessionId,
      purpose: event.purpose,
      api: event.api,
      model: event.model,
      servedModel: event.servedModel ?? previous?.servedModel,
      windowSource: event.window && event.window > 0 ? 'catalog' : (previous?.windowSource ?? 'unknown'),
      inputLeafId: event.inputLeafId ?? previous?.inputLeafId,
      resultEntryId: event.resultEntryId ?? previous?.resultEntryId,
      phase: event.phase,
      done: event.phase !== 'payload',
      prompt: prompt ? calibratePrompt(prompt, counted, event.window) : undefined,
      usage: event.usage ?? (samePayload ? previous?.usage : undefined),
      cacheKnowledge: event.cacheKnowledge,
      bodyState: body?.body
        ? 'memory'
        : (event.bodyState ?? (event.phase === 'payload' ? 'missing' : previous?.bodyState) ?? 'missing'),
      replyState,
      replyCut,
      error: event.error,
      parserVersion: 1,
    }
    session.records.set(event.id, record)
    const operation = async () => {
      if (this.deleted.has(sessionId)) return
      await mkdir(session.directory, { recursive: true, mode: 0o700 })
      if (event.phase === 'payload' || !samePayload)
        await rm(path.join(session.directory, `${hash(event.id)}.gz`), { force: true })
      if (this.archiveEnabled() && !session.temporary && body && event.phase !== 'payload') {
        const encoded = JSON.stringify({ version: 1, body: body.body, reply: body.reply, revision: body.revision })
        const compressed = await compress(encoded)
        if (this.deleted.has(sessionId)) return
        await this.atomic(path.join(session.directory, `${hash(event.id)}.gz`), compressed)
        if (record.bodyState === 'memory') record.bodyState = 'archive'
        if (record.replyState === 'memory') record.replyState = 'archive'
      }
      if (!this.deleted.has(sessionId))
        await this.atomic(path.join(session.directory, `${hash(event.id)}.json`), JSON.stringify(record))
    }
    const pending = (this.writes.get(sessionId) ?? Promise.resolve()).catch(() => {}).then(operation)
    this.writes.set(sessionId, pending)
    try {
      await pending
    } finally {
      if (this.writes.get(sessionId) === pending) this.writes.delete(sessionId)
    }
    if (++this.updates % 100 === 0 || (this.archiveEnabled() && event.phase !== 'payload')) {
      this.maintenance = this.maintenance.catch(() => {}).then(() => this.prune())
      void this.maintenance.catch((cause: unknown) => console.error('上下文历史清理失败', cause))
    }
    return record
  }

  private trimBodies() {
    let bytes = [...this.bodies.values()].reduce((sum, value) => sum + value.bytes, 0)
    while (this.bodies.size > limits.retainedRequests || bytes > limits.retainedBytes) {
      const oldest = this.bodies.entries().next().value
      if (!oldest) break
      bytes -= oldest[1].bytes
      this.bodies.delete(oldest[0])
    }
  }

  private async atomic(file: string, data: string | Uint8Array) {
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, data, { mode: 0o600 })
      await rename(temporary, file)
    } finally {
      await rm(temporary, { force: true })
    }
  }

  async list(sessionId: string, query: ContextListQuery = {}): Promise<ContextRequestPage> {
    const session = await this.session(sessionId)
    const records = [...session.records.values()]
      .filter((record) => query.includeAuxiliary || record.purpose === 'main')
      .sort((a, b) => b.sequence - a.sequence)
    const index = query.cursor ? records.findIndex((record) => record.id === query.cursor) + 1 : 0
    if (query.cursor && !index) throw new Error('请求分页游标已失效，请重新读取')
    const limit = bounded(query.limit, 50, 100)
    const selected = records.slice(index, index + limit)
    return {
      requests: selected.map((record) => this.visibleState(sessionId, record)),
      total: records.length,
      nextCursor: index + limit < records.length ? selected.at(-1)?.id : undefined,
    }
  }

  async get(sessionId: string, id: string) {
    const session = await this.session(sessionId)
    const record = session.records.get(id)
    if (!record) throw new Error('此请求的上下文历史已不可用')
    return this.visibleState(sessionId, record)
  }

  private visibleState(sessionId: string, record: ContextRequest): ContextRequest {
    const cached = this.bodies.get(this.key(sessionId, record.id))
    return {
      ...record,
      bodyState: cached?.body ? 'memory' : record.bodyState === 'memory' ? 'off' : record.bodyState,
      replyState: cached?.reply ? record.replyState : record.replyState === 'memory' ? 'off' : record.replyState,
    }
  }

  private async readBody(sessionId: string, requestId: string, payloadRevision?: number) {
    const session = await this.session(sessionId)
    const stored = session.records.get(requestId)
    if (!stored) throw new Error('此请求的上下文历史已不可用')
    const record = this.visibleState(sessionId, stored)
    if (payloadRevision !== undefined) {
      if (!Number.isSafeInteger(payloadRevision) || payloadRevision < 0) throw new Error('正文版本无效')
      if (record.payloadRevision !== payloadRevision) throw new Error('此请求正文已更新，请关闭后重新打开')
    }
    // Read metadata and its cached body without an await between the two versions.
    const cached = this.bodies.get(this.key(sessionId, requestId))
    if (cached) {
      this.bodies.delete(this.key(sessionId, requestId))
      this.bodies.set(this.key(sessionId, requestId), cached)
      return { record, body: cached, from: 'memory' as const }
    }
    if (record.bodyState !== 'archive' && record.replyState !== 'archive') return { record }
    try {
      const file = path.join(session.directory, `${hash(requestId)}.gz`)
      const archiveLimit = limits.bodyBytes * 3 + 1024 * 1024
      if ((await stat(file)).size > archiveLimit) return { record, state: 'too-large' as const }
      const expanded = await decompress(await readFile(file), { maxOutputLength: archiveLimit })
      const body = JSON.parse(expanded.toString('utf8')) as StoredBody
      if (
        body.version !== 1 ||
        body.revision !== record.payloadRevision ||
        (body.body !== undefined && typeof body.body !== 'string') ||
        (body.reply !== undefined &&
          (!Array.isArray(body.reply) ||
            body.reply.some(
              (piece) =>
                !piece ||
                typeof piece.role !== 'string' ||
                (piece.text !== undefined && typeof piece.text !== 'string') ||
                (piece.src !== undefined && typeof piece.src !== 'string'),
            )))
      )
        return { record, state: 'unread' as const }
      return { record, body: { ...body, bytes: expanded.byteLength }, from: 'archive' as const }
    } catch (cause) {
      return { record, state: missing(cause) ? ('missing' as const) : ('unread' as const) }
    }
  }

  private async items(sessionId: string, query: ContextItemQuery) {
    if (!contextPartKinds.includes(query.kind)) throw new Error('上下文分类无效')
    const resolved = await this.readBody(sessionId, query.requestId, query.payloadRevision)
    let items = resolved.body?.body ? promptItems(resolved.record.api, resolved.body.body, query.kind) : []
    if (resolved.record.prompt?.counted && resolved.body?.body && items.length) {
      const estimated = inspectPrompt(resolved.record.api, resolved.body.body)?.tokens ?? 0
      items = scalePromptItems(
        items,
        resolved.record.prompt.tokens,
        estimated,
        resolved.record.prompt.parts.find((part) => part.kind === query.kind)?.tokens,
      )
    }
    return { ...resolved, items }
  }

  async item(sessionId: string, query: ContextItemQuery): Promise<ContextItemPage> {
    const result = await this.items(sessionId, query)
    const offset = bounded(query.offset, 0, 1_000_000, true)
    const limit = bounded(query.limit, 100, 100)
    const items = query.itemId ? result.items.filter((item) => item.id === query.itemId) : result.items
    if (query.itemId && result.body?.body && !items.length) throw new Error('上下文项目不存在')
    return {
      state: result.body?.body ? result.from! : (result.state ?? result.record.bodyState),
      from: result.from,
      kept: limits.retainedRequests,
      items: items.slice(offset, offset + limit).map((item) => ({ ...item, pieces: item.pieces.map(pieceMetadata) })),
      total: items.length,
      nextOffset: offset + limit < items.length ? offset + limit : undefined,
    }
  }

  async reply(sessionId: string, requestId: string): Promise<ContextReplyPage> {
    const result = await this.readBody(sessionId, requestId)
    return {
      state: result.body?.reply
        ? result.record.replyCut
          ? 'cut'
          : result.from!
        : (result.state ?? result.record.replyState),
      from: result.from,
      pieces: (result.body?.reply ?? []).map(pieceMetadata),
      cut: result.record.replyCut,
    }
  }

  private async resolvePiece(sessionId: string, query: ContextPieceQuery) {
    const index = bounded(query.pieceIndex, 0, 1_000_000, true)
    if (query.kind === 'reply') {
      const result = await this.readBody(sessionId, query.requestId, query.payloadRevision)
      return {
        state: result.body?.reply ? result.from! : (result.state ?? result.record.replyState),
        piece: result.body?.reply?.[index],
      }
    }
    const result = await this.items(sessionId, { ...query, kind: query.kind })
    if (!query.itemId) throw new Error('缺少上下文项目身份')
    const item = result.items.find((candidate) => candidate.id === query.itemId)
    return {
      state: result.body?.body ? result.from! : (result.state ?? result.record.bodyState),
      piece: item?.pieces[index],
    }
  }

  async piece(sessionId: string, query: ContextPieceQuery): Promise<ContextPiecePage> {
    const { state, piece } = await this.resolvePiece(sessionId, query)
    if (!piece) return { state, total: 0 }
    const offset = bounded(query.offset, 0, 64 * 1024 * 1024, true)
    const limit = bounded(query.limit, limits.textCharacters, limits.textCharacters)
    const text = piece.text ?? ''
    let end = Math.min(text.length, offset + limit)
    // JSON escaping can use six bytes per UTF-16 unit; cap the serialized text, not just character count.
    while (end > offset && Buffer.byteLength(JSON.stringify(text.slice(offset, end))) > 48 * 1024)
      end = offset + Math.floor((end - offset) * 0.75)
    if (
      end < text.length &&
      end > offset &&
      /[\uD800-\uDBFF]/.test(text[end - 1]!) &&
      /[\uDC00-\uDFFF]/.test(text[end]!)
    ) {
      // Even a one-unit page must advance; retain a complete surrogate pair rather than an empty page.
      end = end === offset + 1 ? end + 1 : end - 1
    }
    return {
      state,
      piece: { ...pieceMetadata(piece), text: text.slice(offset, end) },
      total: text.length,
      nextOffset: end < text.length ? end : undefined,
    }
  }

  async image(sessionId: string, query: ContextPieceQuery): Promise<{ state: ContextBodyState; src?: string }> {
    const { state, piece } = await this.resolvePiece(sessionId, query)
    const src = piece?.src
    if (
      !src ||
      !/^data:image\/(?:png|jpe?g|gif|webp);base64,[a-zA-Z0-9+/=\s]+$/.test(src) ||
      src.length > 12 * 1024 * 1024
    )
      return { state }
    if (Buffer.from(src.slice(src.indexOf(',') + 1), 'base64').byteLength > 8 * 1024 * 1024)
      return { state: 'too-large' }
    return { state, src }
  }

  async deleteSessions(sessionIds: string[]) {
    for (const id of sessionIds) this.deleted.add(id)
    for (const id of sessionIds) {
      await this.writes.get(id)?.catch(() => {})
      const session = this.sessions.get(id)
      await rm(session?.directory ?? path.join(this.directory, hash(id)), { recursive: true, force: true })
      this.sessions.delete(id)
      for (const key of this.bodies.keys()) if ((JSON.parse(key) as string[])[0] === id) this.bodies.delete(key)
    }
  }

  async abortPending(sessionId: string) {
    if (this.deleted.has(sessionId)) return
    const session = await this.session(sessionId)
    for (const record of [...session.records.values()]) {
      if (record.done) continue
      await this.capture(sessionId, {
        ...record,
        payloadRevision: record.payloadRevision,
        phase: 'aborted',
        error: '会话运行已结束',
      })
    }
  }

  private async prune() {
    const files: Array<{ file: string; size: number; time: number; archive: boolean }> = []
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue
      const directory = path.join(this.directory, entry.name)
      for (const name of await readdir(directory)) {
        if (!/^[a-f0-9]{64}\.(?:json|gz)$/.test(name)) continue
        const file = path.join(directory, name)
        const info = await stat(file).catch(() => undefined)
        if (info) files.push({ file, size: info.size, time: info.mtimeMs, archive: name.endsWith('.gz') })
      }
    }
    files.sort((a, b) => a.time - b.time)
    const removed = new Set<string>()
    for (const archive of [false, true]) {
      const selected = files.filter((file) => file.archive === archive)
      let total = selected.reduce((sum, file) => sum + file.size, 0)
      for (const file of selected) {
        if (
          file.time >= Date.now() - limits.days * 86400_000 &&
          total <= (archive ? limits.archiveBytes : limits.summaryBytes)
        )
          break
        await rm(file.file, { force: true })
        removed.add(file.file)
        if (!archive) {
          const companion = file.file.replace(/\.json$/, '.gz')
          await rm(companion, { force: true })
          removed.add(companion)
        }
        total -= file.size
      }
    }
    // Force the next read to reload retained metadata after expiry/eviction.
    for (const session of this.sessions.values()) {
      if (!session.temporary) {
        const cutoff = Date.now() - limits.days * 86400_000
        for (const [id, record] of session.records) {
          if (Date.parse(record.time) < cutoff || removed.has(path.join(session.directory, `${hash(id)}.json`)))
            session.records.delete(id)
          else if (removed.has(path.join(session.directory, `${hash(id)}.gz`))) {
            if (record.bodyState === 'archive') record.bodyState = 'off'
            if (record.replyState === 'archive') record.replyState = 'off'
          }
        }
      }
    }
  }

  async dispose() {
    await Promise.allSettled([...this.writes.values(), this.maintenance])
    this.bodies.clear()
  }
}

function validPrompt(prompt: NonNullable<ContextRequest['prompt']>) {
  return (
    typeof prompt === 'object' &&
    Number.isFinite(prompt.tokens) &&
    prompt.tokens >= 0 &&
    (prompt.window === undefined || (Number.isFinite(prompt.window) && prompt.window > 0)) &&
    Array.isArray(prompt.parts) &&
    prompt.parts.length <= contextPartKinds.length &&
    prompt.parts.every(
      (part) =>
        part &&
        contextPartKinds.includes(part.kind) &&
        Number.isFinite(part.tokens) &&
        part.tokens >= 0 &&
        Array.isArray(part.items) &&
        part.items.length <= 24 &&
        part.items.every(
          (item) =>
            item &&
            typeof item.id === 'string' &&
            typeof item.name === 'string' &&
            Number.isFinite(item.tokens) &&
            item.tokens >= 0,
        ),
    )
  )
}
function pieceMetadata(piece: ContextPiece): ContextPiece {
  return { role: piece.role, name: piece.name, size: piece.size, characters: piece.text?.length ?? 0 }
}
function bounded(value: number | undefined, fallback: number, maximum: number, zero = false) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1) || value > maximum) throw new Error('上下文分页参数无效')
  return value
}
