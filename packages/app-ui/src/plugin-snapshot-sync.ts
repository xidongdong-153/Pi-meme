import type { Snapshot } from '@pi-meme/contracts/desktop'

/** 所有快照来源共用提交顺序，迟到结果不能回滚插件贡献。 */
export class PluginSnapshotSync {
  private revision = 0
  private committed = 0

  begin() {
    return ++this.revision
  }

  commit(revision: number, snapshot: Snapshot, selectedSession: string | undefined) {
    if (revision < this.committed || snapshot.connection.sessionKey !== selectedSession) return false
    this.committed = revision
    return true
  }
}
