import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import {
  validateVisualizationInput,
  validateVisualizationRef,
  type VisualizationDocument,
  type VisualizationRef,
  type SaveVisualizationInput,
} from '@pi-meme/contracts/visualize'

export class VisualizationStore {
  private pending: Promise<unknown> = Promise.resolve()
  constructor(private readonly directory: string) {}

  async read(ref: VisualizationRef, allowed: readonly VisualizationRef[]): Promise<VisualizationDocument> {
    validateVisualizationRef(ref)
    if (!allowed.some((r) => r.id === ref.id && r.revision === ref.revision)) throw new Error('当前分支不可访问此草图')
    const document = JSON.parse(
      await readFile(path.join(this.directory, ref.id, `${ref.revision}.json`), 'utf8'),
    ) as VisualizationDocument
    validateVisualizationInput(document)
    if (document.id !== ref.id || document.revision !== ref.revision || document.schemaVersion !== 1)
      throw new Error('草图文件无效')
    return document
  }

  save(input: SaveVisualizationInput, callId: string, allowed: readonly VisualizationRef[], assertActive: () => void) {
    const operation = this.pending.then(async () => {
      validateVisualizationInput(input)
      assertActive()
      if (input.reference) {
        await this.read(input.reference, allowed)
      }
      const digest = createHash('sha256').update(callId).digest('hex')
      const id =
        input.reference?.id ??
        `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`
      const directory = path.join(this.directory, id)
      await mkdir(directory, { recursive: true })
      const revisions = (await readdir(directory))
        .filter((f) => /^\d+\.json$/.test(f))
        .map((f) => Number(f.slice(0, -5)))
      for (const revision of revisions) {
        const previous = JSON.parse(
          await readFile(path.join(directory, `${revision}.json`), 'utf8'),
        ) as VisualizationDocument
        if (previous.callId === callId) return previous
      }
      if (
        input.reference &&
        allowed.some((r) => r.id === input.reference!.id && r.revision > input.reference!.revision)
      )
        throw new Error('草图版本已更新，请读取最新版本')
      const revision = Math.max(0, ...revisions) + 1
      const document: VisualizationDocument = {
        ...input,
        schemaVersion: 1,
        id,
        revision,
        callId,
        createdAt: new Date().toISOString(),
      }
      const temporary = path.join(directory, `${randomUUID()}.tmp`)
      try {
        await writeFile(temporary, JSON.stringify(document), { flag: 'wx', mode: 0o600 })
        assertActive()
        await rename(temporary, path.join(directory, `${revision}.json`))
      } finally {
        await rm(temporary, { force: true })
      }
      return document
    })
    this.pending = operation.catch(() => {})
    return operation
  }
}
