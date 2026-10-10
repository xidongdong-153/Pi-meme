import type { PiImage, PiMessage, PiSessionEntries } from '@pi-meme/contracts/pi'

export type ToolRun = {
  id: string
  name: string
  parentToolCallId?: string
  children?: ToolRun[]
  args?: unknown
  result?: unknown
  status: 'running' | 'success' | 'error'
}
export type ChatCompactionState = {
  active: boolean
}

export type ChatState = {
  messages: PiMessage[]
  sessionEntries?: PiSessionEntries
  live: Extract<PiMessage, { role: 'assistant' }> | null
  stream: LiveStream
  tools: Record<string, ToolRun>
  running: boolean
  compacting: ChatCompactionState | null
  steering: readonly string[]
  followUp: readonly string[]
}

export type LiveStream = { arguments: Record<number, string>; completed: Record<number, boolean> }
export type ActivityItem =
  | {
      id: string
      type: 'thinking'
      thinking: string
      status?: 'running' | 'success'
    }
  | {
      id: string
      type: 'narration'
      text: string
      status?: 'success'
    }
  | {
      id: string
      type?: 'tool'
      name?: string
      children?: ToolRun[]
      command?: string
      output?: string
      args?: unknown
      result?: unknown
      status?: 'running' | 'success' | 'error'
    }

export type ActionItemData = ActivityItem

export type RenderSegment = { type: 'text'; text: string } | { type: 'activity'; items: ActivityItem[] }

export type TurnChunk =
  | {
      type: 'user'
      message: PiMessage
      key: string
    }
  | {
      type: 'assistant_turn'
      activities: ActivityItem[]
      finalText: string
      images: Array<PiImage & { id?: string }>
      errorMessage?: string
      durationMs?: number
      startedAt?: number
      isLive: boolean
      key: string
    }
  | {
      type: 'compaction'
      kind: 'compaction' | 'branch_summary'
      summary: string
      tokensBefore?: number
      timestamp?: number
      key: string
    }
