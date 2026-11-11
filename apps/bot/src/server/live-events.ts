import { LiveDoc } from '@earendil-works/pi-durable'
import type { Conversation, ConversationWatch, LiveState } from '@earendil-works/pi-durable'
import type { Task, TaskLive } from '../shared/types.js'
import { context } from './store.js'

/** Presentation follows Durable's public live document; it never writes the business document. */
export class BotLiveEvents {
  private values = new Map<string, TaskLive>()
  private listeners = new Set<(value: TaskLive) => void>()
  private watches = new Map<string, ConversationWatch>()
  snapshot(conversationId?: string) {
    return [...this.values.values()].filter((value) => !conversationId || value.conversationId === conversationId)
  }
  subscribe(listener: (value: TaskLive) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private publish(task: Task, state?: LiveState) {
    const previous = this.values.get(task.id)
    const message = state?.generation?.message
    const submissionIds = state?.run?.inputs.map(String) ?? []
    const sameInputs =
      previous?.submissionIds.length === submissionIds.length &&
      submissionIds.every((id, index) => previous.submissionIds[index] === id)
    const value: TaskLive = {
      taskId: task.id,
      conversationId: task.conversationId,
      botId: task.botId,
      version: (previous?.version ?? 0) + 1,
      generation: task.liveGeneration ?? 0,
      runId: task.runtimeId,
      submissionIds,
      text:
        message?.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('') ?? (submissionIds.length && !sameInputs ? '' : (previous?.text ?? '')),
      tool:
        state?.tools
          ?.filter((slot) => slot.status === 'running')
          .map((slot) => slot.name)
          .join('、') || undefined,
      status: task.status,
    }
    this.values.set(task.id, value)
    for (const listener of this.listeners) {
      try {
        listener(value)
      } catch {
        /* A disconnected subscriber cannot stop the execution. */
      }
    }
  }
  async attach(task: Task, conversation: Conversation) {
    if (this.watches.has(task.id)) return
    const watch = await conversation.watch(context, { min: 1, max: 2 })
    this.watches.set(task.id, watch)
    this.publish(task, watch.value.docs[LiveDoc.definition.kind] as LiveState | undefined)
    watch.start(async (call) => {
      if (call.kind === 'value') this.publish(task, call.value.docs[LiveDoc.definition.kind] as LiveState | undefined)
    })
  }
  async detach(task: Task) {
    const watch = this.watches.get(task.id)
    this.watches.delete(task.id)
    await watch?.stop()
    const final = this.values.get(task.id)
    this.publish(task)
    this.values.delete(task.id)
    return final
  }
  async close() {
    await Promise.all([...this.watches.values()].map((watch) => watch.stop()))
    this.watches.clear()
    this.values.clear()
    this.listeners.clear()
  }
}
