import type { PiEvent, PiGenerationMetrics } from '@pi-meme/contracts/pi'

const encoder = new TextEncoder()

export class GenerationMetricsTracker {
  private startedAt?: number
  private endedAt?: number
  private requestStartedAt?: number
  private generationMs = 0
  private ttftMs?: number
  private outputTokens = 0
  private estimated = false
  private requestOutput = 0
  private requestBytes = 0
  private phase: PiGenerationMetrics['phase'] = 'waiting'

  constructor(private readonly now = () => performance.now()) {}

  reset() {
    this.startedAt = undefined
    this.endedAt = undefined
    this.requestStartedAt = undefined
    this.generationMs = 0
    this.ttftMs = undefined
    this.outputTokens = 0
    this.estimated = false
    this.requestOutput = 0
    this.requestBytes = 0
    this.phase = 'waiting'
  }

  handle(event: PiEvent) {
    const now = this.now()
    if (event.type === 'agent_start' && (this.startedAt === undefined || this.endedAt !== undefined)) {
      this.reset()
      this.startedAt = now
      this.phase = 'waiting'
    }
    if (this.startedAt === undefined || this.endedAt !== undefined) return
    if (event.type === 'turn_start') {
      this.startRequest(now)
    } else if (event.type === 'message_start' && event.message.role === 'assistant') {
      if (this.requestStartedAt === undefined) this.startRequest(now)
    } else if (event.type === 'message_update') {
      if (this.requestStartedAt === undefined) this.startRequest(now)
      this.requestOutput = Math.max(this.requestOutput, event.usage.output)
      const update = event.assistantMessageEvent
      if ('delta' in update && typeof update.delta === 'string' && update.delta.length > 0) {
        this.ttftMs ??= Math.max(0, now - this.requestStartedAt!)
        this.requestBytes += encoder.encode(update.delta).byteLength
        this.phase = 'generating'
      }
    } else if (event.type === 'message_end' && event.message.role === 'assistant') {
      this.requestOutput = event.message.usage.output
      this.finishRequest(now)
      this.phase = 'waiting'
    } else if (event.type === 'tool_execution_start') {
      this.phase = 'tools'
    } else if (event.type === 'agent_settled') {
      this.finishRequest(now)
      this.endedAt = now
      this.phase = event.aborted ? 'aborted' : 'complete'
    }
  }

  snapshot(): PiGenerationMetrics | undefined {
    if (this.startedAt === undefined) return undefined
    const now = this.endedAt ?? this.now()
    const active = this.requestStartedAt !== undefined
    const estimated = active && this.requestOutput === 0 && this.requestBytes > 0
    return {
      running: this.endedAt === undefined,
      phase: this.phase,
      elapsedMs: Math.max(0, now - this.startedAt),
      generationMs: this.generationMs + (active ? Math.max(0, now - this.requestStartedAt!) : 0),
      generationActive: active,
      ttftMs: this.ttftMs,
      outputTokens: this.outputTokens + (active ? this.currentOutput() : 0),
      estimated: this.estimated || estimated,
    }
  }

  private startRequest(now: number) {
    this.requestStartedAt = now
    this.requestOutput = 0
    this.requestBytes = 0
    this.phase = 'waiting'
  }

  private currentOutput() {
    // 分词器与隐藏推理因模型而异，流式近似值始终带估算标记。
    return this.requestOutput > 0 ? this.requestOutput : Math.ceil(this.requestBytes / 4)
  }

  private finishRequest(now: number) {
    if (this.requestStartedAt === undefined) return
    this.generationMs += Math.max(0, now - this.requestStartedAt)
    this.outputTokens += this.currentOutput()
    this.estimated ||= this.requestOutput === 0 && this.requestBytes > 0
    this.requestStartedAt = undefined
    this.requestOutput = 0
    this.requestBytes = 0
  }
}
