import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { MoreHorizontal } from 'lucide-react'
import type { UiContributionProps } from '@pi-meme/plugin-sdk/ui'
import type { RegisteredMessageAction } from '@pi-meme/plugin-sdk/message-actions'
import type { UiMessageActionSubject } from '@pi-meme/contracts/plugin-ui-data'
import { freezeUiValue } from '@pi-meme/contracts/plugin-ui-data'
import type { MessageActionAnchor } from '@pi-meme/ui/components/plugin-message-actions'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@pi-meme/ui/components/ui/dropdown-menu'
import type { UiPluginRegistry } from './plugin-registry'

function subjectKey(subject: UiMessageActionSubject) {
  return JSON.stringify([
    subject.role,
    subject.refs,
    subject.revision,
    subject.state,
    subject.toolCallId,
    subject.toolName,
    subject.customType,
    subject.source?.ownerId,
    subject.source?.generation,
    subject.source?.toolName,
    subject.source?.customType,
  ])
}
function invocationKey(action: RegisteredMessageAction, subjectIdentity: string) {
  return JSON.stringify([action.pluginId, action.generation, action.id, subjectIdentity])
}
type ActionGroup = { anchor: MessageActionAnchor; subject: UiMessageActionSubject; identity: string; title: string }

export function matchesMessageAction(action: RegisteredMessageAction, subject: UiMessageActionSubject) {
  return (
    action.match.roles.includes(subject.role) &&
    (action.match.source === 'any' || subject.source?.ownerId === action.pluginId) &&
    (!action.match.toolName || action.match.toolName === subject.toolName) &&
    (!action.match.customType || action.match.customType === subject.customType)
  )
}

export function PluginMessageActionMenu({
  registry,
  props,
  anchor,
  anchors,
}: {
  registry: UiPluginRegistry
  props: UiContributionProps
} & ({ anchor: MessageActionAnchor; anchors?: never } | { anchor?: never; anchors: readonly MessageActionAnchor[] })) {
  const actions = useSyncExternalStore(registry.subscribe, registry.getMessageActions, registry.getMessageActions)
  const [busy, setBusy] = useState<readonly string[]>([])
  const [error, setError] = useState('')
  const controllers = useRef(new Map<string, AbortController>())
  const mounted = useRef(true)
  const target = useMemo(() => freezeUiValue(structuredClone(props.target)), [props.target])
  const groups = useMemo<ActionGroup[]>(() => {
    const session = target.session
    const result = new Map<string, ActionGroup>()
    for (const item of anchors ?? (anchor ? [anchor] : [])) {
      const { entries, label, ...display } = item
      const subject: UiMessageActionSubject = freezeUiValue({
        ...display,
        source: display.source ? { ...display.source } : undefined,
        refs: session
          ? [...new Map(entries.map((entry) => [entry.id, entry])).values()].map((entry) => ({
              session: { hostId: session.hostId, sessionId: session.sessionId },
              entryId: entry.id,
            }))
          : [],
        revision: entries.map((entry) => entry.revision).join(':'),
      })
      if (!subject.refs.length || subject.state === 'streaming') continue
      const identity = subjectKey(subject)
      result.set(identity, {
        anchor: item,
        subject,
        identity,
        title:
          subject.role === 'tool'
            ? [subject.toolName ?? '工具', label, subject.toolCallId].filter(Boolean).join(' · ')
            : (label ?? subject.role),
      })
    }
    return [...result.values()]
  }, [anchor, anchors, target])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      for (const controller of controllers.current.values()) controller.abort()
      controllers.current.clear()
    }
  }, [])
  useEffect(() => {
    const valid = new Map<string, RegisteredMessageAction>()
    for (const group of groups)
      for (const action of actions) {
        if (matchesMessageAction(action, group.subject)) valid.set(invocationKey(action, group.identity), action)
      }
    for (const [key, controller] of controllers.current) {
      const action = valid.get(key)
      if (action && registry.getMessageActionContext(action, controller.signal)) continue
      controller.abort()
      controllers.current.delete(key)
    }
    setBusy((value) => {
      const next = value.filter((key) => controllers.current.has(key))
      return next.length === value.length ? value : next
    })
  }, [actions, groups, registry])
  const matchedGroups = groups
    .map((group) => ({ ...group, actions: actions.filter((action) => matchesMessageAction(action, group.subject)) }))
    .filter((group) => group.actions.length)
  if (!matchedGroups.length) return null

  async function execute(action: RegisteredMessageAction, group: ActionGroup) {
    const key = invocationKey(action, group.identity)
    if (controllers.current.has(key)) return
    const abort = new AbortController()
    const context = registry.getMessageActionContext(action, abort.signal)
    if (!context) {
      abort.abort()
      setError('插件已退役或消息操作授权已撤销')
      return
    }
    controllers.current.set(key, abort)
    const cancel = () => abort.abort()
    context.signal.addEventListener('abort', cancel, { once: true })
    if (context.signal.aborted) abort.abort()
    setBusy((value) => [...value, key])
    setError('')
    try {
      const captured = freezeUiValue(structuredClone(group.subject))
      const messages = await Promise.all(captured.refs.map((ref) => context.messages.getMessage(ref)))
      if (abort.signal.aborted) throw new Error('cancelled：消息操作已取消')
      const current = registry.getMessageActionContext(action, abort.signal)
      if (!current) throw new Error('plugin-retired：插件已退役')
      const eligibility = action.isEnabled?.({ subject: captured, target })
      if (eligibility === false || (typeof eligibility === 'object' && !eligibility.enabled))
        throw new Error(typeof eligibility === 'object' ? eligibility.reason : '当前消息不能执行此操作')
      const expected = new Map(group.anchor.entries.map((entry) => [entry.id, entry.revision]))
      if (messages.some((message) => message.ref && expected.get(message.ref.entryId) !== message.revision))
        throw new Error('stale-message：消息内容已变化，请重新打开操作菜单')
      await action.execute({
        subject: captured,
        target,
        messages: freezeUiValue(structuredClone(messages)),
        signal: abort.signal,
        host: current.host,
      })
    } catch (cause) {
      if (mounted.current && !abort.signal.aborted && controllers.current.get(key) === abort)
        setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      context.signal.removeEventListener('abort', cancel)
      abort.abort()
      if (controllers.current.get(key) === abort) {
        controllers.current.delete(key)
        if (mounted.current) setBusy((value) => value.filter((id) => id !== key))
      }
    }
  }

  return (
    <span className="inline-flex items-center" onClick={(event) => event.stopPropagation()}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="插件消息操作"
            title={error || '插件消息操作'}
            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <MoreHorizontal className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {matchedGroups.map((group, index) => (
            <Fragment key={group.identity}>
              {index > 0 && <DropdownMenuSeparator />}
              <div role="group" aria-label={group.title}>
                {matchedGroups.length > 1 && (
                  <div className="max-w-80 truncate px-2.5 py-1 text-xs text-muted-foreground" title={group.title}>
                    {group.title}
                  </div>
                )}
                {group.actions.map((action) => {
                  let reason: string | undefined
                  try {
                    const value = action.isEnabled?.({ subject: group.subject, target })
                    reason =
                      value === false
                        ? '当前消息不可执行'
                        : typeof value === 'object' && !value.enabled
                          ? value.reason
                          : undefined
                  } catch {
                    reason = '插件无法检查此操作'
                  }
                  const key = invocationKey(action, group.identity)
                  return (
                    <DropdownMenuItem
                      key={key}
                      disabled={Boolean(reason) || busy.includes(key)}
                      title={reason}
                      onSelect={() => {
                        void execute(action, group)
                      }}
                    >
                      {action.icon && (
                        <span className="flex size-4 items-center justify-center overflow-hidden [&>svg]:size-4">
                          {action.icon}
                        </span>
                      )}
                      {busy.includes(key) ? `${action.title}（执行中）` : action.title}
                    </DropdownMenuItem>
                  )
                })}
              </div>
            </Fragment>
          ))}
          {error && (
            <p role="alert" className="max-w-72 px-2 py-1 text-xs text-destructive">
              {error}
            </p>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  )
}
