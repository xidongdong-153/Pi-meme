import type { Message, Task, TaskStatus } from '../shared/types'

type TimelineItem =
  | { kind: 'message'; id: string; createdAt: string; message: Message }
  | { kind: 'partial'; id: string; createdAt: string; task: Task }

const partialStatuses = new Set<TaskStatus>(['failed', 'stopped', 'unknown', 'blocked'])

export function buildMessageTimeline(messages: Message[], tasks: Task[], hasOlder: boolean): TimelineItem[] {
  const messageById = new Map(messages.map((message) => [message.id, message]))
  const taskById = new Map(tasks.map((task) => [task.id, task]))
  const publishedTaskIds = new Set<string>()
  const publishedRuntimeIds = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.taskId) continue
    publishedTaskIds.add(message.taskId)
    const runtimeId = taskById.get(message.taskId)?.runtimeId
    if (runtimeId) publishedRuntimeIds.add(runtimeId)
  }

  const partials = tasks
    .filter(
      (task) =>
        task.publicReply &&
        task.partialResult?.trim() &&
        partialStatuses.has(task.status) &&
        !publishedTaskIds.has(task.id) &&
        !(task.runtimeId && publishedRuntimeIds.has(task.runtimeId)),
    )
    .map((task) => ({
      kind: 'partial' as const,
      id: `partial:${task.id}`,
      createdAt: task.finishedAt ?? task.updatedAt,
      task,
      sourceSequence: Math.max(messageById.get(task.sourceMessageId)?.sequence ?? 0, task.contextThroughSequence ?? 0),
      time: Date.parse(task.finishedAt ?? task.updatedAt),
    }))
    .filter(
      (item) =>
        !hasOlder ||
        (messages[0] &&
          (item.time >= Date.parse(messages[0].createdAt) || item.sourceSequence >= messages[0].sequence)),
    )
    .sort((a, b) => a.time - b.time || a.sourceSequence - b.sourceSequence || a.id.localeCompare(b.id))

  const items: TimelineItem[] = []
  let index = 0
  for (const partial of partials) {
    // Keep persisted message sequence authoritative. Equal timestamps place the reply after its source.
    while (
      index < messages.length &&
      (messages[index].sequence <= partial.sourceSequence || Date.parse(messages[index].createdAt) < partial.time)
    ) {
      const message = messages[index++]
      items.push({ kind: 'message', id: message.id, createdAt: message.createdAt, message })
    }
    items.push(partial)
  }
  for (const message of messages.slice(index)) {
    items.push({ kind: 'message', id: message.id, createdAt: message.createdAt, message })
  }
  return items
}
