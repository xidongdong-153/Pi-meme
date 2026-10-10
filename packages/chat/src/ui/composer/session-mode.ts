import type { TaskMode } from '@pi-meme/contracts/plan'

export class SessionMode {
  revision = 0
  private key?: string
  private mode: TaskMode = 'default'
  private readonly pending = new Map<string, { revision: number; mode: TaskMode }>()

  change(key: string, mode: TaskMode) {
    const revision = ++this.revision
    this.key = key
    this.mode = mode
    this.pending.set(key, { revision, mode })
    return revision
  }
  settled(key: string, revision: number) {
    if (this.pending.get(key)?.revision === revision) this.pending.delete(key)
  }
  snapshot(key: string | undefined, persisted: TaskMode, readRevision: number) {
    if (key === this.key && readRevision < this.revision) return this.mode
    this.key = key
    this.mode = (key && this.pending.get(key)?.mode) || persisted
    return this.mode
  }
}
