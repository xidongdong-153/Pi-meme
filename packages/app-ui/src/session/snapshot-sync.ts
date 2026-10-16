import type { Connection, DesktopEvent } from '@pi-meme/contracts/desktop'

export type SnapshotRead = { connection: Connection; events: DesktopEvent[] }

export class SnapshotSync {
  private current: SnapshotRead | null = null

  begin(connection: Connection): SnapshotRead {
    const read = { connection, events: [] }
    this.current = read
    return read
  }

  owns(read: SnapshotRead, connection: Connection) {
    return (
      this.current === read &&
      read.connection.generation === connection.generation &&
      read.connection.sessionKey === connection.sessionKey
    )
  }

  receive(event: DesktopEvent) {
    if (
      this.current &&
      event.generation === this.current.connection.generation &&
      event.sessionKey === this.current.connection.sessionKey
    )
      this.current.events.push(event)
  }

  finish(read: SnapshotRead) {
    if (this.current === read) this.current = null
  }

  cancel() {
    this.current = null
  }
}
