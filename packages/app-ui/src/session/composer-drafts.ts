import type { ComposerSnapshot } from '@pi-meme/chat/ui/use-chat-session'
import type { PiSlashCommand } from '@pi-meme/contracts/pi'

export const composerDraftPrefix = 'pi-meme:composer:v1:'
type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function isSkill(value: unknown): value is PiSlashCommand {
  if (!value || typeof value !== 'object') return false
  const skill = value as Partial<PiSlashCommand>
  return (
    typeof skill.name === 'string' &&
    skill.source === 'skill' &&
    typeof skill.resourceId === 'string' &&
    typeof skill.resourceRevision === 'string' &&
    typeof skill.sourceInfo?.path === 'string'
  )
}

export class ComposerDrafts {
  private readonly values = new Map<string, ComposerSnapshot>()
  private readonly pending = new Map<string, Set<ComposerSnapshot>>()
  private readonly identities = new Map<string, string>()
  private readonly failed = new Set<string>()

  constructor(
    private readonly hostId: string,
    private readonly storage: () => DraftStorage = () => window.localStorage,
  ) {}

  private key(sessionKey: string) {
    const sessionId = this.identities.get(sessionKey)
    return sessionId ? composerDraftPrefix + JSON.stringify([this.hostId, sessionId]) : undefined
  }

  bind(sessionKey: string, sessionId: string): ComposerSnapshot | undefined {
    if (this.identities.get(sessionKey) === sessionId) return
    this.identities.set(sessionKey, sessionId)
    const current = this.values.get(sessionKey)
    if (
      current &&
      (current.draft ||
        current.goalDraft ||
        current.attachments.length ||
        current.selectedSkills.length ||
        current.pluginMentions?.length)
    ) {
      this.persist(sessionKey)
      return
    }
    if (this.pending.get(sessionKey)?.size) {
      this.persist(sessionKey)
      return
    }
    this.values.delete(sessionKey)
    return this.get(sessionKey)
  }

  get(sessionKey: string): ComposerSnapshot | undefined {
    const cached = this.values.get(sessionKey)
    if (cached) return cached
    const key = this.key(sessionKey)
    if (!key) return
    try {
      const saved: unknown = JSON.parse(this.storage().getItem(key) ?? 'null')
      if (!saved || typeof saved !== 'object') return
      const value = saved as Partial<ComposerSnapshot>
      if (
        typeof value.draft !== 'string' ||
        !Array.isArray(value.selectedSkills) ||
        !value.selectedSkills.every(isSkill) ||
        (value.pluginMentions !== undefined &&
          (!Array.isArray(value.pluginMentions) ||
            !value.pluginMentions.every((id) => typeof id === 'string' && id.length > 0))) ||
        (value.queueMode !== 'steering' && value.queueMode !== 'followUp')
      )
        return
      const composer: ComposerSnapshot = {
        draft: value.draft,
        selectedSkills: value.selectedSkills,
        ...(value.goalDraft ? { goalDraft: true as const } : {}),
        ...(value.pluginMentions?.length ? { pluginMentions: value.pluginMentions } : {}),
        ...(value.pluginAnchors && typeof value.pluginAnchors === 'object'
          ? {
              pluginAnchors: Object.fromEntries(
                Object.entries(value.pluginAnchors).filter(
                  ([id, offset]) =>
                    value.pluginMentions?.includes(id) &&
                    Number.isInteger(offset) &&
                    offset >= 0 &&
                    offset <= value.draft!.length,
                ),
              ),
            }
          : {}),
        attachments: [],
        queueMode: value.queueMode,
      }
      this.values.set(sessionKey, composer)
      return composer
    } catch {
      // 损坏的记录或不可读存储不影响窗口内输入。
    }
  }

  set(sessionKey: string, composer: ComposerSnapshot) {
    this.values.set(sessionKey, composer)
    this.persist(sessionKey)
  }

  delete(sessionKey: string) {
    this.values.delete(sessionKey)
    this.pending.delete(sessionKey)
    this.persist(sessionKey)
  }

  hasInput = () =>
    [...this.values.values()].some(
      (composer) =>
        composer.draft ||
        composer.goalDraft ||
        composer.attachments.length ||
        composer.selectedSkills.length ||
        composer.pluginMentions?.length ||
        composer.editing,
    ) || [...this.pending.values()].some((pending) => pending.size > 0)

  hasUnstoredInput = () => {
    for (const [key, composer] of this.values) {
      if (
        composer.attachments.length ||
        ((composer.draft || composer.goalDraft || composer.pluginMentions?.length) &&
          (!this.key(key) || this.failed.has(key)))
      )
        return true
    }
    return [...this.pending.values()].some((pending) =>
      [...pending].some((composer) => composer.attachments.length > 0),
    )
  }

  startSend(sessionKey: string, composer: ComposerSnapshot) {
    const pending = this.pending.get(sessionKey) ?? new Set<ComposerSnapshot>()
    pending.add(composer)
    this.pending.set(sessionKey, pending)
    this.persist(sessionKey)
    return () => {
      pending.delete(composer)
      if (!pending.size && this.pending.get(sessionKey) === pending) this.pending.delete(sessionKey)
      this.persist(sessionKey)
    }
  }

  private persist(sessionKey: string) {
    const key = this.key(sessionKey)
    if (!key) return
    const current = this.values.get(sessionKey)
    // 历史消息和队列编辑不替换普通草稿；图片只在当前窗口内保留。
    let composer = current?.editing?.restore ?? current
    if (!composer?.draft && !composer?.pluginMentions?.length)
      composer = this.pending.get(sessionKey)?.values().next().value ?? composer
    try {
      if (composer && (composer.draft || composer.goalDraft || composer.pluginMentions?.length))
        this.storage().setItem(
          key,
          JSON.stringify({
            draft: composer.draft,
            ...(composer.goalDraft ? { goalDraft: composer.goalDraft } : {}),
            selectedSkills: composer.selectedSkills,
            ...(composer.pluginMentions?.length
              ? {
                  pluginMentions: composer.pluginMentions,
                  ...(composer.pluginAnchors ? { pluginAnchors: composer.pluginAnchors } : {}),
                }
              : {}),
            queueMode: composer.queueMode,
          }),
        )
      else this.storage().removeItem(key)
      this.failed.delete(sessionKey)
    } catch {
      this.failed.add(sessionKey)
      // 存储被禁用或空间不足时，仍保留窗口内的草稿。
    }
  }
}
