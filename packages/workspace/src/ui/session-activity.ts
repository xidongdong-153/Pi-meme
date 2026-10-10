import type { PiSessionsSnapshot } from '@pi-meme/contracts/sessions'

export class SessionActivity {
  private selected: Pick<PiSessionsSnapshot, 'activeSessionPath' | 'activeSessionId'> | null = null

  select(sessionPath?: string, sessionId?: string) {
    this.selected = { activeSessionPath: sessionPath, activeSessionId: sessionId }
  }

  apply(snapshot: PiSessionsSnapshot) {
    return this.selected ? { ...snapshot, ...this.selected } : snapshot
  }
}
