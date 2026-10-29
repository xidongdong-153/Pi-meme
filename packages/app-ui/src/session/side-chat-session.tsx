import { useEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import { createPortal } from 'react-dom'
import type { HostApi } from '@pi-meme/contracts/app-host'
import type { DesktopBridge } from '@pi-meme/contracts/desktop'
import type { ResourceClient } from '@pi-meme/client/resource-client'
import type { UiPluginDescriptor } from '@pi-meme/plugin-sdk/ui'
import type { RegisteredBeforeSendHook } from '@pi-meme/plugin-sdk/composer'
import { Composer } from '@pi-meme/chat/ui/composer/composer'
import { Conversation } from '@pi-meme/chat/ui/conversation/conversation'
import { MessageImageLoaderContext } from '@pi-meme/chat/ui/content/message-image'
import { GoalControl } from '@pi-meme/goals/ui/goal-control'
import { ExtensionDialog } from '@pi-meme/interaction/ui/extension-dialog'
import { ExtensionStatusBadges } from '@pi-meme/interaction/ui/extension-statuses'
import { ExtensionWidgets } from '@pi-meme/interaction/ui/extension-widgets'
import { UserInputPanel } from '@pi-meme/interaction/ui/user-input-panel'
import { ModelPickerPopover } from '@pi-meme/models/ui/model-picker-popover'
import { ContextUsageRing } from '@pi-meme/models/ui/context-usage-ring'
import { AgentAccessSelector } from '@pi-meme/permissions/ui/agent-access-selector'
import { Button } from '@pi-meme/ui/components/ui/button'
import { sessionUiTarget } from '../layout/panel-layout'
import { PlanCard } from '../panels/plan-card'
import { PlanDecision } from '../panels/plan-decision'
import { PlanPanel } from '../panels/plan-panel'
import { SideChatPanel } from '../panels/side-chat-panel'
import { SubagentsPanel } from '../panels/subagents-panel'
import { useAgentPluginSelection } from '../plugins/use-agent-plugin-selection'
import { usePluginComposerController } from '../plugins/plugin-composer-adapter'
import { beforeSendHookAvailable, pluginUiGranted, type UiPluginRegistry } from '../plugins/plugin-registry'
import { PluginRenderers } from '../plugins/plugin-renderers'
import { PluginSlot } from '../plugins/plugin-slot'
import type { PluginUiConsent } from '../plugins/plugin-ui-consent'
import { useAppSession } from './use-app-session'
import { useShortcutHandlers } from '../shortcuts/shortcut-provider'

/** 控制器位于工作区稳定层，面板隐藏或卸载时仍保留临时聊天状态。 */
export function SideChatSession({
  bridge,
  host,
  hostId,
  target,
  resources,
  registry,
  consent,
  plugins,
  hooks,
  authorizationRevision,
  initialDraft,
  showComposerHint,
  showContextUsage,
  closing,
  closeError,
  onRetryClose,
  onLeaveComposer,
  onFocusState,
}: {
  bridge: DesktopBridge
  host: HostApi
  hostId: string
  target: HTMLElement | null
  resources: ResourceClient
  registry: UiPluginRegistry
  consent: PluginUiConsent
  plugins: UiPluginDescriptor[]
  hooks: readonly RegisteredBeforeSendHook[]
  authorizationRevision: string
  initialDraft: string
  showComposerHint: boolean
  showContextUsage: boolean
  closing: boolean
  closeError: string
  onRetryClose: () => void
  onLeaveComposer: () => void
  onFocusState: (focused: boolean) => void
}) {
  const chat = useAppSession(bridge, { host, hostId, workspaceEnabled: false, persistDrafts: false })
  const session = chat.appSession
  const [view, setView] = useState<'chat' | 'plan' | 'agents'>('chat')
  const [focused, setFocused] = useState(false)
  const [openModelsVersion, setOpenModelsVersion] = useState(0)
  const [dismissedPlan, setDismissedPlan] = useState('')
  const generationMetrics = useMemo(
    () => ({
      subscribe: chat.chatStream.subscribe,
      getSnapshot: () => chat.chatStream.getSnapshot().generationMetrics,
    }),
    [chat.chatStream],
  )
  const interaction = chat.extensionDialogs[0]
  const currentPlan = chat.planDocuments[0]
  const ready = chat.connection.status === 'idle' || chat.connection.status === 'ready'
  const locked = closing || Boolean(closeError)
  const focusDraft = useRef(chat.focusDraft)
  const leaveComposer = useRef(onLeaveComposer)
  const reportFocus = useRef(onFocusState)
  leaveComposer.current = onLeaveComposer
  reportFocus.current = onFocusState
  useEffect(
    () => () => {
      reportFocus.current(false)
      leaveComposer.current()
    },
    [],
  )
  useEffect(() => {
    if (!target) {
      setFocused(false)
      reportFocus.current(false)
      leaveComposer.current()
    }
  }, [target])
  const restoredDraft = useRef(false)
  focusDraft.current = chat.focusDraft
  useEffect(() => {
    if (restoredDraft.current || chat.loading || !chat.connection.sessionKey) return
    restoredDraft.current = true
    if (initialDraft) chat.setDraft(initialDraft)
  }, [chat.loading, chat.connection.sessionKey, chat.setDraft, initialDraft])
  useEffect(() => {
    if (target && ready && !chat.inputDisabled && !locked) focusDraft.current()
  }, [target, ready, chat.inputDisabled, locked])

  const selection = useAgentPluginSelection({
    host,
    session,
    plugins,
    resources,
    cwd: chat.connection.cwd,
    pluginMentions: chat.pluginMentions,
    onPluginMentions: chat.setPluginMentions,
    busy: Boolean(locked || chat.busy || chat.chat.paused || chat.chat.queuePaused),
    onChanged: chat.refreshSnapshot,
    onError: chat.setError,
  })
  const requiredHooks = useMemo(
    () =>
      plugins.flatMap((plugin) => {
        const projectPlugin = chat.uiPlugins?.find((entry) => entry.id === plugin.id)
        if (!plugin.enabled || !projectPlugin?.enabled || !pluginUiGranted(plugin, 'composer.before-send')) return []
        return (plugin.permissions?.beforeSend ?? [])
          .filter((id) => plugin.grant?.beforeSend.includes(id))
          .map((hookId) => ({ pluginId: plugin.id, hookId, generation: plugin.generation }))
      }),
    [plugins, chat.uiPlugins],
  )
  const composerIntegration = usePluginComposerController({
    chat,
    hostId,
    session,
    visible: Boolean(target) && !locked,
    agentPlugins: selection,
    hooks,
    requiredHooks,
    authorizationRevision,
    canProcess: (hook) =>
      beforeSendHookAvailable(
        hook,
        plugins.find((entry) => entry.id === hook.pluginId),
        chat.uiPlugins?.find((entry) => entry.id === hook.pluginId),
      ),
  })
  const uiTarget = useMemo(() => sessionUiTarget(hostId, session), [hostId, session])
  const pluginProps = useMemo(() => ({ host, target: uiTarget, snapshot: null }), [host, uiTarget])
  const loadImage = useMemo(() => {
    if (!session) return undefined
    const ref = { hostId: session.hostId, sessionId: session.sessionId }
    return (relativePath: string) => host.files.preview(ref, relativePath)
  }, [host, session])
  useShortcutHandlers(
    {
      pauseTask: () => {
        if (!locked && chat.chat.running && !chat.chat.paused && !chat.chat.queuePaused) void chat.stop()
      },
      togglePlanMode: () => {
        if (
          !locked &&
          !chat.busy &&
          !chat.editing &&
          !chat.editingQueue &&
          !chat.savingQueue &&
          chat.goal?.status !== 'active'
        )
          chat.changeMode(chat.mode === 'plan' ? 'default' : 'plan')
      },
      openModelPicker: () => {
        if (!locked && !chat.modelPickerDisabled && !chat.modelSaving && !chat.editing)
          setOpenModelsVersion((version) => version + 1)
      },
      focusComposer: () => {
        if (!locked && !chat.inputDisabled) chat.focusDraft()
      },
    },
    Boolean(target) && focused,
  )
  const model = (
    <ModelPickerPopover
      models={chat.models}
      currentModel={chat.selectedConfiguration.model}
      thinkingLevel={chat.selectedConfiguration.thinkingLevel}
      disabled={chat.modelPickerDisabled || locked}
      busy={chat.modelSaving}
      openModelsVersion={openModelsVersion}
      onSelectModel={(value) => void chat.selectModel(value)}
      onSelectThinkingLevel={(value) => void chat.selectThinkingLevel(value)}
    />
  )
  const access = (
    <AgentAccessSelector
      mode={chat.connection.accessMode}
      busy={chat.accessBusy || locked}
      supported={chat.connection.restrictedAccessSupported === true}
      onChange={(value) => void chat.setAccessMode(value)}
    />
  )
  const composerProps: ComponentProps<typeof Composer> = {
    mode: chat.mode,
    onMode: chat.changeMode,
    onPlanCommand: chat.inputDisabled || locked ? undefined : chat.activatePlan,
    onGoalCommand: chat.goalsSupported && !chat.inputDisabled && !locked ? chat.activateGoal : undefined,
    onCompact: chat.inputDisabled || locked ? undefined : () => void chat.compactNow(),
    sessionStarted: chat.chat.messages.length > 0 || chat.chat.live !== null,
    [chat.goalDraft ? 'goalControl' : 'goalBanner']: chat.goalsSupported ? (
      <GoalControl
        goal={chat.goalDraft ? undefined : chat.goal}
        draft={chat.goalDraft}
        onDraft={chat.setGoalDraft}
        open={chat.goalOpen}
        onOpen={chat.setGoalOpen}
        editing={chat.goalEditing}
        running={chat.chat.running}
        onAction={chat.goalAction}
        onSave={chat.saveGoal}
        onError={chat.setError}
      />
    ) : undefined,
    recoveredInputs: chat.recoveredInputs,
    onRestoreQueuedInput: chat.restoreQueuedInput,
    sessionKey: chat.connection.sessionKey,
    attachmentContextKey: JSON.stringify([chat.editingEntryId, chat.editingQueue]),
    composerStore: chat.composerStore,
    files: chat.composerFiles,
    uploadAttachment: bridge.uploadAttachment,
    projectPath: chat.connection.cwd,
    loadProjectFiles: chat.inputDisabled || locked ? undefined : bridge.getProjectFiles,
    access,
    selectedSkills: chat.selectedSkills,
    onSkills: chat.setSelectedSkills,
    agentPlugins: selection,
    draft: chat.draft,
    onDraft: chat.setDraft,
    hint: showComposerHint ? chat.composerHint : undefined,
    onAcceptHint: chat.acceptComposerHint,
    onDismissHint: chat.dismissComposerHint,
    attachments: chat.attachments,
    onAddImages: (images) => chat.setAttachments((value) => [...value, ...images]),
    onRemoveImage: (id) => chat.setAttachments((value) => value.filter((image) => image.id !== id)),
    running: chat.chat.running,
    paused: chat.chat.paused || chat.chat.stopped,
    stopped: chat.chat.stopped,
    queuePaused: chat.chat.queuePaused,
    activeMode: chat.chat.activeMode,
    activeConfiguration: { model: chat.state?.model, thinkingLevel: chat.state?.thinkingLevel },
    editingQueue: chat.editingQueue !== null,
    onResume: () => void chat.resume(),
    onResumeQueue: () => void chat.resumeQueue(),
    resumeLabel: chat.goal?.status === 'paused' ? '继续目标' : undefined,
    recovery: chat.chat.goal && chat.chat.goal.status !== 'complete' ? undefined : chat.chat.recovery,
    recovering: chat.recovering,
    onRecover: () => void chat.recover(),
    onSteerQueueInput: (id) => void chat.steerQueueInput(id),
    onDeleteQueueInput: (id) => void chat.deleteQueueInput(id),
    onEditQueueInput: (id) => void chat.editQueueInput(id),
    disabled: !ready || chat.inputDisabled || chat.savingQueue || locked,
    editorDisabled: !chat.draftEditable || chat.savingQueue || locked,
    queueMode: chat.queueMode,
    onQueueMode: chat.setQueueMode,
    steeringMode: chat.state?.steeringMode,
    followUpMode: chat.state?.followUpMode,
    onSteeringMode: chat.setSteeringMode,
    onFollowUpMode: chat.setFollowUpMode,
    queues: { steering: chat.chat.steering, followUp: chat.chat.followUp },
    onSend: () => void chat.send(),
    onStop: chat.stop,
    onClearQueue: () => void chat.clearQueue(),
    editing: chat.editing,
    onCancelEdit: chat.cancelEdit,
    commands: chat.commands,
    widgetsAbove: (
      <>
        <ExtensionWidgets widgets={chat.extensionWidgets} placement="aboveEditor" />
        <PluginSlot registry={registry} slot="composer" props={pluginProps} />
      </>
    ),
    widgetsBelow: (
      <>
        <ExtensionWidgets widgets={chat.extensionWidgets} placement="belowEditor" />
        <PluginSlot registry={registry} slot="composer-actions" props={pluginProps} />
      </>
    ),
    statusBadges: (
      <>
        <ExtensionStatusBadges statuses={chat.extensionStatuses} />
        <PluginSlot registry={registry} slot="status" props={pluginProps} />
      </>
    ),
    focusVersion: chat.draftFocusVersion,
    onError: chat.setError,
    contextUsage: showContextUsage ? (
      <ContextUsageRing stats={chat.sessionStats} generationMetrics={generationMetrics} />
    ) : null,
    model,
  }
  const editor =
    chat.editing && chat.editingEntryId !== null
      ? {
          entryId: chat.editingEntryId,
          model,
          submitting: chat.editSubmitting,
          submissionLabel: chat.connection.editPhase === 'sending' ? '正在重新发送' : '正在停止原任务',
          composerStore: chat.composerStore,
          files: chat.composerFiles,
          sessionKey: chat.connection.sessionKey,
          uploadAttachment: bridge.uploadAttachment,
          onError: chat.setError,
          projectPath: chat.connection.cwd,
          loadProjectFiles: bridge.getProjectFiles,
          draft: chat.draft,
          onDraft: chat.setDraft,
          selectedSkills: chat.selectedSkills,
          onSkills: chat.setSelectedSkills,
          attachments: chat.attachments,
          onAddImages: (images: typeof chat.attachments) => chat.setAttachments((value) => [...value, ...images]),
          onRemoveImage: (id: string) => chat.setAttachments((value) => value.filter((image) => image.id !== id)),
          commands: chat.commands,
          agentPlugins: selection,
          focusVersion: chat.draftFocusVersion,
          disabled: !ready || chat.inputDisabled || locked,
          onSubmit: () => void chat.send(),
          onCancel: chat.cancelEdit,
        }
      : undefined
  const conversation = (
    <Conversation
      chat={chat.chat}
      stream={chat.chatStream}
      onLoadOlder={chat.loadOlderMessages}
      historyLoading={chat.historyLoading}
      canEditMessages={!chat.inputDisabled && !chat.navigationBusy && !chat.editing && !locked}
      canForkReplies={false}
      onEditMessage={chat.editMessage}
      onForkReply={() => {}}
      onCopyError={chat.setError}
      editor={editor}
      sessionKey={chat.connection.sessionKey}
      models={chat.models}
      loadImage={loadImage}
      cwd={session?.cwd ?? chat.connection.cwd}
      fileSession={session}
      planState={chat.planState ?? (chat.editing ? null : undefined)}
      renderPlan={(document) => <PlanCard document={document} onOpen={() => setView('plan')} />}
    />
  )
  const input = chat.editing ? (
    <p className="px-3 py-2 text-center text-xs text-muted-foreground">正在编辑历史消息</p>
  ) : (
    <>
      {interaction?.method === 'questions' && (
        <UserInputPanel
          key={interaction.id}
          request={interaction}
          sourceName={interaction.source?.name}
          onRespond={chat.answerExtensionDialog}
          draft={chat.getQuestionDraft(interaction.id)}
          onDraft={(draft) => chat.saveQuestionDraft(interaction.id, draft)}
        />
      )}
      {currentPlan && chat.mode === 'plan' ? (
        <PlanDecision
          key={`${hostId}:${currentPlan.id}:${currentPlan.revision}`}
          document={currentPlan}
          hostId={hostId}
          persistDismissal={false}
          initiallyDismissed={dismissedPlan === `${currentPlan.id}:${currentPlan.revision}`}
          onDismiss={() => setDismissedPlan(`${currentPlan.id}:${currentPlan.revision}`)}
          visible={!chat.busy && !chat.navigationBusy && !chat.editing && !interaction && !locked}
          draft={chat.planDraft}
          onDraftChange={chat.setPlanDraft}
          readOnly={chat.connection.accessMode === 'read-only'}
          model={model}
          access={access}
          onSubmit={chat.submitPlan}
          onSkip={(text) => {
            if (text.trim()) chat.setDraft((draft) => [draft.trimEnd(), text].filter(Boolean).join('\n\n'))
            chat.focusDraft()
          }}
        >
          <Composer {...composerProps} />
        </PlanDecision>
      ) : (
        <Composer {...composerProps} />
      )}
    </>
  )
  const hasConversation = Boolean(chat.chat.messages.length || chat.chat.live || chat.chat.running)
  const hasAgents = chat.chat.agents?.some(
    (agent) => agent.parentAgentId && agent.rootSessionKey === chat.connection.sessionKey,
  )
  const notice = (
    <>
      {(currentPlan || hasAgents || view !== 'chat') && (
        <div className="flex shrink-0 items-center gap-1 px-2 py-1">
          {view !== 'chat' && (
            <Button size="sm" variant="ghost" onClick={() => setView('chat')}>
              返回聊天
            </Button>
          )}
          {currentPlan && view !== 'plan' && (
            <Button size="sm" variant="ghost" onClick={() => setView('plan')}>
              计划
            </Button>
          )}
          {hasAgents && view !== 'agents' && (
            <Button size="sm" variant="ghost" onClick={() => setView('agents')}>
              子代理
            </Button>
          )}
        </div>
      )}
      {(chat.error || chat.extensionError?.message || composerIntegration.availabilityReason) && (
        <p role="alert" className="px-3 py-2 text-xs text-destructive">
          {chat.error || chat.extensionError?.message || composerIntegration.availabilityReason}
        </p>
      )}
      {composerIntegration.view?.failure && (
        <div role="alert" className="px-3 py-2 text-xs text-destructive">
          {composerIntegration.view.failure.title}：{composerIntegration.view.failure.reason}
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => void composerIntegration.retry()}>
              重试
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                const failure = composerIntegration.view?.failure
                if (!failure) return
                const signal = composerIntegration.getFailureSignal(failure.attemptId)
                if (!signal || signal.aborted) return
                void consent
                  .request({
                    pluginId: failure.pluginId,
                    title: '仅本次跳过发送前处理？',
                    description: `跳过 ${failure.title}，不改变长期授权。草稿或目标变化后，本次许可失效。`,
                    signal,
                  })
                  .then((accepted) => (accepted ? composerIntegration.skip(failure.attemptId) : undefined))
                  .catch((cause) => chat.setError(String(cause)))
              }}
            >
              仅本次跳过
            </Button>
          </div>
        </div>
      )}
      {chat.failedDrafts.map((draft, index) => (
        <div key={index} className="flex items-center gap-2 px-3 text-xs">
          <span className="min-w-0 flex-1 truncate">发送失败：{draft.draft.slice(0, 80) || '附件'}</span>
          <Button
            size="sm"
            variant="ghost"
            disabled={Boolean(chat.draft || chat.attachments.length)}
            onClick={() => chat.restoreFailedDraft(index)}
          >
            恢复草稿
          </Button>
        </div>
      ))}
    </>
  )
  if (!target) return null
  return createPortal(
    <PluginRenderers registry={registry} props={pluginProps}>
      <MessageImageLoaderContext value={loadImage}>
        <div
          className="flex h-full min-h-0 flex-1 flex-col"
          onFocusCapture={() => {
            setFocused(true)
            onFocusState(true)
            registry.setComposerController(composerIntegration.adapter)
          }}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) {
              setFocused(false)
              onFocusState(false)
              onLeaveComposer()
            }
          }}
        >
          <SideChatPanel
            hasConversation={hasConversation || view !== 'chat'}
            conversation={
              view === 'plan' ? (
                <PlanPanel documents={chat.planDocuments} />
              ) : view === 'agents' ? (
                <SubagentsPanel bridge={bridge} sessionKey={chat.connection.sessionKey} />
              ) : (
                conversation
              )
            }
            composer={view === 'chat' ? input : undefined}
            closing={closing}
            closeError={closeError}
            onRetryClose={onRetryClose}
            notice={notice}
          />
          {!locked && interaction && interaction.method !== 'questions' && (
            <ExtensionDialog
              key={interaction.id}
              request={interaction}
              sourceName={interaction.source?.name}
              onRespond={chat.answerExtensionDialog}
            />
          )}
        </div>
      </MessageImageLoaderContext>
    </PluginRenderers>,
    target,
  )
}
