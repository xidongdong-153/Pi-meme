import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { AppSession } from '@pi-meme/contracts/app-host'
import { freezeUiValue } from '@pi-meme/contracts/plugin-ui-data'
import type {
  ComposerAdapter,
  ComposerEditResult,
  ComposerInline,
  ComposerIntent,
  ComposerRef,
  ComposerView,
  PreparedComposerInput,
  RegisteredBeforeSendHook,
} from '@pi-meme/plugin-sdk/composer'
import type { ComposerAgentPlugins } from '@pi-meme/chat/ui/composer/composer'
import {
  composerDocument,
  documentLength,
  applyComposerSteps,
  parseComposerDocument,
} from '@pi-meme/chat/ui/composer/composer-document'
import { ComposerPipeline } from '@pi-meme/chat/ui/composer/composer-submit'
import type { ComposerDraftState } from '@pi-meme/chat/ui/composer/composer-state'
import type { useAppSession } from '../session/use-app-session'

type Chat = ReturnType<typeof useAppSession>
export type RequiredBeforeSendHook = { pluginId: string; hookId: string; generation: number }
export type PluginComposerOptions = {
  chat: Chat
  hostId?: string
  session?: AppSession
  visible: boolean
  agentPlugins?: ComposerAgentPlugins
  hooks: readonly RegisteredBeforeSendHook[]
  requiredHooks?: readonly RequiredBeforeSendHook[]
  authorizationRevision: string | number
  canProcess: (hook: RegisteredBeforeSendHook, ref: ComposerRef) => boolean
}
const rejected = (code: string, reason: string): ComposerEditResult => ({ status: 'rejected', code, reason })

export class PluginComposerController implements ComposerAdapter {
  private options!: PluginComposerOptions
  private readonly id = crypto.randomUUID()
  private epoch = 0
  private contextKey = ''
  private draftKey = crypto.randomUUID()
  private readonly listeners = new Set<() => void>()
  private readonly pipeline = new ComposerPipeline()
  private releaseStore?: () => void
  private store?: Chat['composerStore']
  private revision = -1
  private presentationKey = ''
  private policyKey = ''
  private cached?: {
    source: ComposerDraftState
    processing: ReturnType<ComposerPipeline['getSnapshot']>
    key: string
    value: ComposerView | null
  }
  private pending?: { source: ComposerDraftState; ref: ComposerRef; policyKey: string }
  constructor() {
    this.pipeline.subscribe(() => {
      this.cached = undefined
      this.publish()
    })
  }
  private publish = () => {
    for (const listener of this.listeners) listener()
  }
  update(options: PluginComposerOptions) {
    const previous = this.options
    this.options = options
    if (this.store !== options.chat.composerStore) {
      this.releaseStore?.()
      this.store = options.chat.composerStore
      this.revision = this.store.getSnapshot().revision
      this.releaseStore = this.store.subscribe(() => {
        const source = this.store!.getSnapshot()
        if (source.revision !== this.revision || source.composing) {
          this.revision = source.revision
          this.pending = undefined
          this.pipeline.cancel()
        }
        this.cached = undefined
        this.publish()
      })
    }
    const key = JSON.stringify([
      options.hostId,
      options.chat.connection.sessionKey,
      options.session?.sessionId,
      options.visible,
      options.chat.editingEntryId,
      options.chat.editingQueue,
      options.chat.connection.cwd,
    ])
    if (key !== this.contextKey) {
      this.contextKey = key
      this.epoch++
      this.cached = undefined
      this.pending = undefined
      if (previous && previous.chat.connection.sessionKey !== options.chat.connection.sessionKey)
        this.draftKey = crypto.randomUUID()
      if (previous)
        queueMicrotask(() => {
          this.pipeline.cancel()
          previous.chat.composerFiles.cancel()
          this.publish()
        })
    }
    const policyKey = JSON.stringify([
      options.authorizationRevision,
      options.chat.mode,
      options.chat.connection.accessMode,
      options.chat.connection.generation,
      options.requiredHooks?.map((hook) => [hook.pluginId, hook.hookId, hook.generation]),
      options.hooks.map((hook) => [
        hook.pluginId,
        hook.id,
        hook.generation,
        hook.order,
        options.canProcess(hook, this.ref()),
      ]),
    ])
    if (this.policyKey && this.policyKey !== policyKey) {
      this.pending = undefined
      queueMicrotask(() => this.pipeline.cancel('发送前处理授权或任务配置已变化'))
    }
    this.policyKey = policyKey
    this.presentationKey = JSON.stringify([
      key,
      options.authorizationRevision,
      options.chat.inputDisabled,
      options.chat.savingQueue,
      options.agentPlugins?.saving,
      options.chat.loading,
      options.chat.connection.status,
      options.chat.composerFiles.uploads.map((upload) => [upload.id, upload.progress]),
      options.requiredHooks?.map((hook) => [hook.pluginId, hook.hookId, hook.generation]),
      options.hooks.map((hook) => [hook.pluginId, hook.id, hook.generation, options.canProcess(hook, this.ref())]),
    ])
    options.chat.setSubmissionIntegration({
      blocked: this.blocked,
      prepare: this.prepare,
      isPreparedCurrent: () =>
        Boolean(
          this.pending && this.owns(this.pending.ref) && this.pending.policyKey === this.policyKey && !this.blocked(),
        ),
    })
  }
  private ref(): ComposerRef {
    const { chat, session, hostId } = this.options
    const edited = chat.chat.messages.find(
      (message) => message.role === 'user' && message.sourceEntry?.id === chat.editingEntryId,
    )
    return {
      id: this.id,
      epoch: this.epoch,
      target:
        chat.connection.workspaceKind === 'project'
          ? { kind: 'project-draft', draftKey: this.draftKey, hostId, project: session?.project }
          : { kind: 'standalone-draft', draftKey: this.draftKey, hostId },
      ...(session ? { session: { hostId: session.hostId, sessionId: session.sessionId } } : {}),
      context:
        chat.editingEntryId !== null && session && edited?.sourceEntry
          ? {
              kind: 'edit-message',
              message: {
                session: { hostId: session.hostId, sessionId: session.sessionId },
                entryId: edited.sourceEntry.id,
              },
            }
          : chat.editingQueue
            ? { kind: 'edit-queue', inputId: chat.editingQueue }
            : { kind: 'draft' },
    }
  }
  private owns(ref: ComposerRef) {
    return this.options.visible && ref.id === this.id && ref.epoch === this.epoch
  }
  availabilityReason = (): string | undefined => {
    for (const required of this.options.requiredHooks ?? []) {
      const hook = this.options.hooks.find(
        (hook) =>
          hook.pluginId === required.pluginId && hook.id === required.hookId && hook.generation === required.generation,
      )
      const label = `${required.pluginId}/${required.hookId}（代次 ${required.generation}）`
      if (!hook) return `发送前处理器 ${label} 尚未注册，请等待插件加载完成`
      if (!this.options.canProcess(hook, this.ref()))
        return `发送前处理器 ${label} 当前不可用，请等待授权或插件状态同步`
    }
    return undefined
  }
  private blocked = () => {
    const { chat, visible, agentPlugins } = this.options
    if (!visible) return '当前没有可见的聊天输入框'
    if (chat.inputDisabled || chat.savingQueue) return '当前输入框暂不可提交'
    if (agentPlugins?.saving) return '正在保存 Agent 插件选择'
    if (chat.composerStore.getSnapshot().composing) return '请先完成输入法组合输入'
    if (chat.composerFiles.isUploading()) return '请等待附件上传完成'
    return this.availabilityReason()
  }
  current = (): ComposerView | null => {
    if (!this.options || !this.options.visible) return null
    if (this.options.chat.editingEntryId !== null && this.ref().context.kind !== 'edit-message') return null
    const source = this.options.chat.composerStore.getSnapshot()
    const processing = this.pipeline.getSnapshot()
    if (
      this.cached?.source === source &&
      this.cached.processing === processing &&
      this.cached.key === this.presentationKey
    )
      return this.cached.value
    const ref = this.ref()
    const hooks = this.effectiveHooks(ref)
    const reason = this.blocked() ?? (!this.options.chat.canSubmitComposer() ? '请先连接服务并完成会话配置' : undefined)
    const value: ComposerView = {
      ref,
      revision: source.revision,
      document: composerDocument(source),
      selection: source.selection ? { ...source.selection } : null,
      selectionRevision: source.selectionRevision,
      capabilities: [
        'read',
        ...(!this.options.chat.inputDisabled && !this.options.chat.savingQueue && !source.composing
          ? ['write' as const, 'attachments' as const]
          : []),
        ...(!reason ? ['submit' as const] : []),
      ],
      blockedReasons: {
        ...(reason ? { submit: reason } : {}),
        ...(source.composing ? { write: '请先完成输入法组合输入' } : {}),
      },
      attachments: [
        ...source.attachments.map((attachment) => ({
          id: attachment.id,
          name: attachment.name ?? '图片',
          kind: attachment.type === 'image' ? ('image' as const) : ('file' as const),
          status: 'ready' as const,
          mimeType: attachment.type === 'image' ? attachment.mimeType : undefined,
        })),
        ...this.options.chat.composerFiles.uploads.map((upload) => ({
          id: upload.id,
          name: upload.name,
          kind: 'file' as const,
          status: 'uploading' as const,
          progress: upload.progress,
        })),
      ],
      composing: source.composing,
      editable: !this.options.chat.inputDisabled && !this.options.chat.savingQueue,
      canSubmit: !reason && processing.status !== 'preparing',
      disabledReason: reason,
      submissionState: processing.status,
      failure: processing.failure,
      processors: hooks.map((hook) => ({
        pluginId: hook.pluginId,
        hookId: hook.id,
        title: hook.title,
        generation: hook.generation,
      })),
    }
    const publicView = freezeUiValue(structuredClone(value))
    this.cached = { source, processing, key: this.presentationKey, value: publicView }
    return publicView
  }
  getSnapshot = (ref: ComposerRef) => (this.owns(ref) ? this.current() : null)
  subscribe = (_ref: ComposerRef, listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  subscribeAll = (listener: () => void) => this.subscribe(this.ref(), listener)
  private writable(ref: ComposerRef) {
    if (!this.owns(ref)) return rejected('stale-composer', '输入框目标已变化，请重新获取引用')
    if (this.options.chat.composerStore.getSnapshot().composing)
      return rejected('composition-active', '请先完成输入法组合输入')
    if (this.pipeline.getSnapshot().status === 'preparing')
      return rejected('hook-reentrancy', '发送前处理期间不能由插件改写输入框')
    if (this.options.chat.inputDisabled || this.options.chat.savingQueue)
      return rejected('input-disabled', '当前输入框不可编辑')
    return null
  }
  apply: ComposerAdapter['apply'] = (ref, input) => {
    const blocked = this.writable(ref)
    if (blocked) return blocked
    const { composerStore, commands } = this.options.chat
    const source = composerStore.getSnapshot()
    if (source.revision !== input.expectedRevision) return rejected('stale-draft', '草稿已变化，请重新读取后操作')
    try {
      const value = applyComposerSteps(source, input.steps, commands)
      const length = documentLength(composerDocument({ ...source, ...value }))
      if (
        input.selection &&
        [input.selection.anchor, input.selection.focus].some(
          (offset) => !Number.isInteger(offset) || offset < 0 || offset > length,
        )
      )
        return rejected('invalid-selection', '选区范围无效')
      composerStore.applyEdit(value, input.selection)
      return { status: 'applied', revision: composerStore.getSnapshot().revision }
    } catch (cause) {
      return rejected('invalid-transaction', cause instanceof Error ? cause.message : String(cause))
    }
  }
  focus: ComposerAdapter['focus'] = (ref, selection) => {
    const blocked = this.writable(ref)
    if (blocked) return blocked
    const length = documentLength(this.current()?.document ?? [])
    if (
      selection &&
      [selection.anchor, selection.focus].some((offset) => !Number.isInteger(offset) || offset < 0 || offset > length)
    )
      return rejected('invalid-selection', '选区范围无效')
    this.options.chat.composerStore.editor?.focus(selection)
    return { status: 'applied', revision: this.options.chat.composerStore.getSnapshot().revision }
  }
  addAttachments: ComposerAdapter['addAttachments'] = async (ref, files, options) => {
    const blocked = this.writable(ref)
    if (blocked) return blocked
    if (options?.signal?.aborted) return rejected('aborted', '附件上传已取消')
    await this.options.chat.composerFiles.addFiles(
      files.map((file) => new File([file.data], file.name, { type: file.data.type })),
      { signal: options?.signal },
    )
    return this.owns(ref)
      ? { status: 'applied', revision: this.options.chat.composerStore.getSnapshot().revision }
      : rejected('stale-composer', '输入框目标已变化')
  }
  cancelAttachment: ComposerAdapter['cancelAttachment'] = (ref, id) => {
    const blocked = this.writable(ref)
    if (blocked) return blocked
    this.options.chat.composerFiles.cancelUpload(id)
    return { status: 'applied', revision: this.options.chat.composerStore.getSnapshot().revision }
  }
  selectAgentPlugin: ComposerAdapter['selectAgentPlugin'] = async (ref, id) => {
    const blocked = this.writable(ref)
    if (blocked) return blocked
    const selected = await this.options.agentPlugins?.select(id)
    return selected && this.owns(ref)
      ? { status: 'applied', revision: this.options.chat.composerStore.getSnapshot().revision }
      : rejected('plugin-selection-failed', '无法选择 Agent 插件')
  }
  removeAgentPlugin: ComposerAdapter['removeAgentPlugin'] = async (ref, id) => {
    const blocked = this.writable(ref)
    if (blocked) return blocked
    const plugins = this.options.agentPlugins
    const changed = await plugins?.change(
      plugins.selected.filter((plugin) => plugin.id !== id).map((plugin) => plugin.id),
    )
    return changed && this.owns(ref)
      ? { status: 'applied', revision: this.options.chat.composerStore.getSnapshot().revision }
      : rejected('plugin-selection-failed', '无法移除 Agent 插件')
  }
  submit: ComposerAdapter['submit'] = async (ref, input) => {
    const blocked = this.writable(ref)
    if (blocked?.status === 'rejected') return { status: 'blocked', code: blocked.code, reason: blocked.reason }
    if (this.options.chat.composerStore.getSnapshot().revision !== input.expectedRevision)
      return { status: 'blocked', code: 'stale-draft', reason: '草稿已变化' }
    if (input.signal?.aborted) return { status: 'cancelled', reason: '发送已取消' }
    const source = this.current()
    if (!source?.canSubmit)
      return { status: 'blocked', code: 'input-disabled', reason: source?.disabledReason ?? '暂不可发送' }
    const cancel = () => this.pipeline.cancel('发送已取消')
    input.signal?.addEventListener('abort', cancel, { once: true })
    try {
      const sent = await this.options.chat.submitComposer()
      return sent
        ? { status: 'submitted', clientRequestId: crypto.randomUUID() }
        : { status: 'blocked', code: 'not-dispatched', reason: '消息尚未投递，请检查草稿和发送前处理状态' }
    } finally {
      input.signal?.removeEventListener('abort', cancel)
    }
  }
  private effectiveHooks(ref: ComposerRef) {
    return this.options.hooks.filter((hook) => this.options.canProcess(hook, ref))
  }
  private prepared(source: ComposerDraftState, input: PreparedComposerInput) {
    if (!Array.isArray(input.document) || !Array.isArray(input.attachmentIds)) throw new Error('发送前处理结果格式无效')
    if (
      new Set(input.attachmentIds).size !== input.attachmentIds.length ||
      input.attachmentIds.some((id) => !source.attachments.some((attachment) => attachment.id === id))
    )
      throw new Error('发送前处理只能选择当前已有的就绪附件')
    const parsed = parseComposerDocument(
      input.document as readonly ComposerInline[],
      this.options.chat.commands,
      source,
    )
    const command = (text: string) => text.trimStart().match(/^\/\S+/u)?.[0]
    if (command(parsed.draft) !== command(source.draft)) throw new Error('发送前处理不能改变宿主命令')
    return {
      ...source,
      ...parsed,
      attachments: input.attachmentIds.map((id) => source.attachments.find((attachment) => attachment.id === id)!),
    }
  }
  private prepare = async (source: ComposerDraftState, intent: ComposerIntent, signal: AbortSignal) => {
    if (signal.aborted || this.blocked()) return null
    const ref = this.ref()
    const policyKey = this.policyKey
    this.pending = { source, ref, policyKey }
    const result = await this.pipeline.prepare({
      ref,
      intent,
      draft: {
        document: composerDocument(source),
        attachmentIds: source.attachments.map((attachment) => attachment.id),
      },
      hooks: this.effectiveHooks(ref),
      signal,
      validate: (input) => {
        this.prepared(source, input)
      },
    })
    if (
      !result ||
      signal.aborted ||
      this.blocked() ||
      !this.owns(ref) ||
      policyKey !== this.policyKey ||
      source.revision !== this.options.chat.composerStore.getSnapshot().revision
    )
      return null
    return { composer: this.prepared(source, result.input), records: result.records }
  }
  getFailureSignal = (attemptId: string): AbortSignal | undefined => {
    const pending = this.pending
    if (
      !pending ||
      pending.policyKey !== this.policyKey ||
      !this.owns(pending.ref) ||
      pending.source.revision !== this.options.chat.composerStore.getSnapshot().revision ||
      this.blocked()
    )
      return undefined
    return this.pipeline.getFailureSignal(attemptId)
  }
  resume = async (skip: boolean, expectedAttemptId?: string) => {
    if (skip && expectedAttemptId && this.pipeline.getSnapshot().failure?.attemptId !== expectedAttemptId) return
    const pending = this.pending
    if (
      !pending ||
      pending.policyKey !== this.policyKey ||
      !this.owns(pending.ref) ||
      pending.source.revision !== this.options.chat.composerStore.getSnapshot().revision ||
      this.blocked()
    )
      return
    const result = await (skip ? this.pipeline.skip() : this.pipeline.retry())
    if (
      !result ||
      pending.policyKey !== this.policyKey ||
      !this.owns(pending.ref) ||
      pending.source.revision !== this.options.chat.composerStore.getSnapshot().revision ||
      this.blocked()
    )
      return
    await this.options.chat.dispatchPreparedComposer(this.prepared(pending.source, result.input), result.records)
  }
  dispose = () => {
    this.releaseStore?.()
    this.pipeline.cancel()
    this.listeners.clear()
    this.options?.chat.setSubmissionIntegration(null)
  }
}

export function usePluginComposerController(options: PluginComposerOptions) {
  const instance = useRef<PluginComposerController | null>(null)
  if (!instance.current) instance.current = new PluginComposerController()
  const controller = instance.current
  controller.update(options)
  const view = useSyncExternalStore(controller.subscribeAll, controller.current, controller.current)
  useEffect(() => () => controller.dispose(), [controller])
  return {
    adapter: controller as ComposerAdapter,
    view,
    availabilityReason: controller.availabilityReason(),
    getFailureSignal: controller.getFailureSignal,
    retry: () => controller.resume(false),
    skip: (attemptId?: string) => controller.resume(true, attemptId),
  }
}
