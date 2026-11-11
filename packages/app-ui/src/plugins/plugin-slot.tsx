import { Fragment, useSyncExternalStore, type ReactNode } from 'react'
import type { UiContribution, UiContributionProps, UiPluginSlot } from '@pi-meme/plugin-sdk/ui'
import { RevealContent } from '@pi-meme/ui/components/reveal-content'
import { ErrorBoundary } from '@pi-meme/ui/components/error-boundary'
import { CollapsibleSection } from '@pi-meme/ui/components/ui/collapsible'
import type { UiPluginRegistry } from './plugin-registry'
import { usePluginSnapshot } from './plugin-snapshot'

export function matchesContribution(entry: UiContribution, props: UiContributionProps) {
  if (entry.slot !== 'tool-card' && entry.slot !== 'message') return true
  if (!entry.match?.ownerId || entry.match.ownerId !== props.ownerId) return false
  if (props.generation === undefined || entry.generation !== props.generation) return false
  if (!props.policyHash || !entry.policyHash || entry.policyHash !== props.policyHash) return false
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
  if (!matched.length && slot !== 'settings') return <>{fallback}</>
  const rendered = (
    <>
      {!matched.length && fallback}
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
          <CollapsibleSection
            key={key}
            title={entry.title ?? props.customType ?? '插件信息'}
            variant="inline"
            className="min-w-0 py-1"
            triggerClassName="text-sm text-muted-foreground"
          >
            {content}
          </CollapsibleSection>
        ) : (
          <Fragment key={key}>{content}</Fragment>
        )
      })}
    </>
  )
  return slot === 'settings' ? (
    <RevealContent ready={matched.length > 0 || fallback !== null}>{rendered}</RevealContent>
  ) : (
    rendered
  )
}

function Contribution({
  render,
  props,
}: {
  render: (props: UiContributionProps) => React.ReactNode
  props: UiContributionProps
}) {
  const liveProps = usePluginSnapshot(props)
  return <>{render(liveProps)}</>
}
