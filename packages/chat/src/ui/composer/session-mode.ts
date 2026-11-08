import type { TaskMode } from '@pi-meme/contracts/plan'

export class SessionMode {
  revision = 0
  private readonly confirmed = new Map<string, { generation: number; revision: number; mode: TaskMode }>()

  confirm(key: string, generation: number, mode: TaskMode) {
    this.confirmed.delete(key)
    this.confirmed.set(key, { generation, revision: ++this.revision, mode })
    if (this.confirmed.size > 20) this.confirmed.delete(this.confirmed.keys().next().value!)
  }
  snapshot(key: string | undefined, generation: number, persisted: TaskMode, readRevision: number) {
    const confirmed = key ? this.confirmed.get(key) : undefined
    // 查看代次在切回同一会话后会增大；确认前开始的读取仍不能覆盖已确认的值。
    if (confirmed && confirmed.generation <= generation && readRevision < confirmed.revision) return confirmed.mode
    return persisted
  }
}
