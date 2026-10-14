import { Fragment, useSyncExternalStore, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import type { UiContribution, UiContributionProps, UiPluginSlot } from '@pi-meme/plugin-sdk/ui'
import { ErrorBoundary } from '@pi-meme/ui/components/error-boundary'
import type { UiPluginRegistry } from './plugin-registry'

export function matchesContribution(entry: UiContribution, props: UiContributionProps) {
  if (entry.slot !== 'tool-card' && entry.slot !== 'message' && entry.slot !== 'message-actions') return true
  if (!entry.match?.ownerId || entry.match.ownerId !== props.ownerId) return false
  if (props.generation === undefined || entry.generation !== props.generation) return false
  return entry.slot === 'tool-card'
    ? entry.match.toolName === props.toolName
    : entry.match.customType === props.customType
}

export function PluginSlot({
  registry,
  slot,
  props,
  pluginId,
  contributionId,
  fallback = null,
}: {
  registry: UiPluginRegistry
  slot: UiPluginSlot
  props: UiContributionProps
  pluginId?: string
  contributionId?: string
  fallback?: ReactNode
}) {
  const contributions = useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot)
  const matched = contributions.filter(
    (entry) =>
      entry.slot === slot &&
      (!pluginId || entry.id.startsWith(`${pluginId}:`)) &&
      (!contributionId || entry.id === contributionId) &&
      matchesContribution(entry, props),
  )
  if (!matched.length) return <>{fallback}</>
  return (
    <>
      {matched.map((entry) => {
        const key = `${entry.id}:${registry.identity(entry.id)}`
        const contribution = (
          <ErrorBoundary inline={slot !== 'settings'} fallbackTitle={`插件界面渲染失败：${entry.title ?? entry.id}`}>
            <Contribution render={entry.render} props={props} />
          </ErrorBoundary>
        )
        const content =
          slot === 'message' || slot === 'tool-card' ? (
            <div className="conversation-contribution contents">{contribution}</div>
          ) : (
            contribution
          )
        return slot === 'message' ? (
          <details key={key} className="group/contribution min-w-0 py-1 text-sm">
            <summary className="flex min-w-0 cursor-pointer list-none items-center gap-1.5 rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
              <span className="truncate">{entry.title ?? props.customType ?? '插件信息'}</span>
              <ChevronRight
                aria-hidden="true"
                className="size-3 shrink-0 transition-transform group-open/contribution:rotate-90"
              />
            </summary>
            {content}
          </details>
        ) : (
          <Fragment key={key}>{content}</Fragment>
        )
      })}
    </>
  )
}

function Contribution({
  render,
  props,
}: {
  render: (props: UiContributionProps) => React.ReactNode
  props: UiContributionProps
}) {
  return <>{render(props)}</>
}
