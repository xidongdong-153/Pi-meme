import { useSyncExternalStore } from 'react'
import type { UiContributionProps, UiPluginSlot } from '@pi-meme/plugin-sdk/ui'
import { ErrorBoundary } from '@pi-meme/ui/components/error-boundary'
import type { UiPluginRegistry } from './plugin-registry'

export function PluginSlot({
  registry,
  slot,
  props,
  pluginId,
  contributionId,
  externalOnly = false,
}: {
  registry: UiPluginRegistry
  slot: UiPluginSlot
  props: UiContributionProps
  pluginId?: string
  contributionId?: string
  externalOnly?: boolean
}) {
  const contributions = useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot)
  return (
    <>
      {contributions
        .filter(
          (entry) =>
            entry.slot === slot &&
            (!pluginId || entry.id.startsWith(`${pluginId}:`)) &&
            (!contributionId || entry.id === contributionId) &&
            (!externalOnly || !registry.isBuiltin(entry.id)),
        )
        .map((entry) => (
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
