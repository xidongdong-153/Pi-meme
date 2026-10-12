import type { ReactNode } from 'react'
import { PluginToolCardProvider } from '@pi-meme/ui/components/plugin-tool-card'
import { PluginMessageProvider } from '@pi-meme/ui/components/plugin-message'
import type { UiContributionProps } from '@pi-meme/plugin-sdk/ui'
import type { UiPluginRegistry } from './plugin-registry'
import { PluginSlot } from './plugin-slot'

export function PluginRenderers({
  registry,
  props,
  children,
}: {
  registry: UiPluginRegistry
  props: UiContributionProps
  children: ReactNode
}) {
  return (
    <PluginToolCardProvider
      render={(tool, source) => (
        <PluginSlot registry={registry} slot="tool-card" props={{ ...props, ...source, tool }} />
      )}
    >
      <PluginMessageProvider
        render={(message, source, fallback) => (
          <PluginSlot registry={registry} slot="message" props={{ ...props, ...source, message }} fallback={fallback} />
        )}
      >
        {children}
      </PluginMessageProvider>
    </PluginToolCardProvider>
  )
}
