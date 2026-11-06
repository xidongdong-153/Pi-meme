import { createHash } from 'node:crypto'
import type { AppSession, SessionRef } from '@pi-meme/contracts/app-host'
import type { Snapshot } from '@pi-meme/contracts/desktop'
import type {
  PiSessionSummary,
  PiSessionsSnapshot,
  SessionAttention,
  SessionReadObservation,
} from '@pi-meme/contracts/sessions'
import type { SessionAttentionStore } from '@pi-meme/workspace/server/session-attention-store'

export function sessionCompletionToken(ref: SessionRef, source: PiSessionSummary['completionSource']) {
  return source
    ? createHash('sha256')
        .update(JSON.stringify([ref.hostId, ref.sessionId, source.id, source.revision]))
        .digest('hex')
    : undefined
}

function summaries(snapshot: PiSessionsSnapshot) {
  return [
    ...new Map(
      [
        ...snapshot.recents,
        ...(snapshot.standaloneSessions ?? []),
        ...snapshot.projects.flatMap((group) => group.sessions),
      ].map((session) => [session.path, session]),
    ).values(),
  ]
}

/** Host 的共享查看投影。读取摘要和正文不会隐式确认查看。 */
export class SessionAttentionService {
  constructor(
    private readonly store: SessionAttentionStore,
    private readonly read: () => Promise<{ snapshot: PiSessionsSnapshot; sessions: AppSession[] }>,
    private readonly runtimeKey: (session: AppSession) => string | undefined,
    private readonly changed: () => void,
  ) {}

  private summaryIndex(snapshot: PiSessionsSnapshot) {
    const index = new Map<string, PiSessionSummary>()
    for (const item of summaries(snapshot)) {
      index.set(item.path, item)
      index.set(item.id, item)
    }
    return index
  }

  private findSummary(session: AppSession, index: Map<string, PiSessionSummary>) {
    return index.get(session.sessionFile ?? '') ?? index.get(this.runtimeKey(session) ?? '')
  }

  private project(session: AppSession, summary?: PiSessionSummary): SessionAttention {
    const ref = { hostId: session.hostId, sessionId: session.sessionId }
    const completionSource = summary?.completionSource
    const completionToken = sessionCompletionToken(ref, completionSource)
    const inputRequestIds = summary?.inputRequestIds ?? []
    return {
      session: ref,
      completionSource,
      completionToken,
      inputRequestIds,
      ...this.store.snapshot(session.sessionId, {
        completionToken,
        inputRequestIds,
        running: summary?.running,
        needsInput: summary?.needsInput,
      }),
    }
  }

  async init() {
    const { snapshot, sessions } = await this.read()
    const index = this.summaryIndex(snapshot)
    await this.store.init(
      sessions.map((session) => ({
        sessionId: session.sessionId,
        completionToken: sessionCompletionToken(session, this.findSummary(session, index)?.completionSource),
      })),
    )
  }

  async get(session: AppSession) {
    const { snapshot } = await this.read()
    return this.project(session, this.findSummary(session, this.summaryIndex(snapshot)))
  }

  async markRead(session: AppSession, input: SessionReadObservation) {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => key !== 'completionToken' && key !== 'inputRequestIds') ||
      (input.completionToken !== undefined &&
        (typeof input.completionToken !== 'string' || !/^[a-f0-9]{64}$/.test(input.completionToken))) ||
      (input.inputRequestIds !== undefined &&
        (!Array.isArray(input.inputRequestIds) ||
          input.inputRequestIds.length > 256 ||
          input.inputRequestIds.some((id) => typeof id !== 'string' || !id || id.length > 2048)))
    )
      throw new Error('会话查看参数无效')
    const { snapshot } = await this.read()
    const summary = this.findSummary(session, this.summaryIndex(snapshot))
    const current = this.project(session, summary)
    if (input.completionToken && input.completionToken !== current.completionToken)
      throw new Error('回复版本已变化，请重新读取会话')
    if (input.completionToken && summary?.running) throw new Error('会话仍在运行，请等待回复完成后再确认')
    const observed = {
      completionToken: input.completionToken,
      // 过期提问不影响新提问；仅确认请求中明确列出且仍属于该会话的项。
      inputRequestIds: input.inputRequestIds?.filter((id) => current.inputRequestIds.includes(id)),
    }
    if (await this.store.markRead(session.sessionId, observed)) this.changed()
    return this.get(session)
  }

  async decorate(snapshot: PiSessionsSnapshot): Promise<PiSessionsSnapshot> {
    const context = await this.read()
    const byPath = new Map<string, SessionAttention>()
    const index = this.summaryIndex(context.snapshot)
    for (const session of context.sessions) {
      const summary = this.findSummary(session, index)
      if (summary) byPath.set(summary.path, this.project(session, summary))
    }
    const decorate = (summary: PiSessionSummary): PiSessionSummary => {
      const attention = byPath.get(summary.path)
      return attention
        ? { ...summary, attention, unread: attention.unread, inputUnread: attention.inputUnread }
        : summary
    }
    return {
      ...snapshot,
      attentionRevision: this.store.snapshot('', { inputRequestIds: [] }).revision,
      recents: snapshot.recents.map(decorate),
      standaloneSessions: snapshot.standaloneSessions?.map(decorate),
      projects: snapshot.projects.map((group) => ({ ...group, sessions: group.sessions.map(decorate) })),
    }
  }

  async forSnapshot(session: AppSession, snapshot: Snapshot): Promise<SessionAttention> {
    const current = await this.get(session)
    // 正文分页/同步可能晚于列表；仅向正文签发实际包含的完成版本。
    const source = current.completionSource
    const included =
      source &&
      snapshot.messages.some(
        (message) => message.sourceEntry?.id === source.id && message.sourceEntry.revision === source.revision,
      )
    return included ? current : { ...current, completionToken: undefined, completionSource: undefined }
  }
}
