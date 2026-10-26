import type { DesktopEvent } from '@pi-meme/contracts/desktop'

export type SelectionTransaction = { id: number; target?: string; replaceable: boolean; events: DesktopEvent[] }

export class SessionSelection {
  private revision = 0
  current: SelectionTransaction | null = null
  pending: Promise<void> | null = null

  begin(target?: string, replaceable = true): SelectionTransaction {
    const transaction = { id: ++this.revision, target, replaceable, events: [] }
    this.current = transaction
    return transaction
  }

  owns(transaction: SelectionTransaction) {
    return this.current === transaction
  }

  finish(transaction: SelectionTransaction) {
    if (!this.owns(transaction)) return
    this.current = null
    this.pending = null
  }

  cancel() {
    this.revision += 1
    this.current = null
    this.pending = null
  }
}
