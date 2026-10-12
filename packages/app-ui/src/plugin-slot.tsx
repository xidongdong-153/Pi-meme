import { useSyncExternalStore, type ReactNode } from 'react'
import type { UiContribution, UiContributionProps, UiPluginSlot } from '@pi-meme/plugin-sdk/ui'
import { ErrorBoundary } from '@pi-meme/ui/components/error-boundary'
import type { UiPluginRegistry } from './plugin-registry'

export function matchesContribution(entry: UiContribution, props: UiContributionProps) {
  if (entry.slot !== 'tool-card' && entry.slot !== 'message') return true
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
      {matched.map((entry) => (
        <ErrorBoundary
          key={`${entry.id}:${registry.identity(entry.id)}`}
          fallbackTitle={`插件界面渲染失败：${entry.title ?? entry.id}`}
        >
          <Contribution render={entry.render} props={props} />
        </ErrorBoundary>
      ))}
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
