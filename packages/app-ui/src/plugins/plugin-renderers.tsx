import type { ReactNode } from 'react'
import { PluginToolCardProvider } from '@pi-meme/ui/components/plugin-tool-card'
import { PluginMessageProvider } from '@pi-meme/ui/components/plugin-message'
import { PluginMessageActionsProvider } from '@pi-meme/ui/components/plugin-message-actions'
import { PluginMessageActionMenu } from './plugin-message-actions'
import type { PiMessage } from '@pi-meme/contracts/pi'
import { projectUiMessage, uiJson } from '@pi-meme/contracts/plugin-ui-message'
import { freezeUiValue } from '@pi-meme/contracts/plugin-ui-data'
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
        <PluginSlot
          registry={registry}
          slot="tool-card"
          props={{ ...props, ...source, tool: freezeUiValue(uiJson(tool)) }}
        />
      )}
    >
      <PluginMessageProvider
        render={(message, source, fallback) => (
          <PluginSlot
            registry={registry}
            slot="message"
            props={{
              ...props,
              ...source,
              message: props.target.session ? projectUiMessage(message as PiMessage, props.target.session) : undefined,
            }}
            fallback={fallback}
          />
        )}
      >
        <PluginMessageActionsProvider
          render={(anchor) => <PluginMessageActionMenu registry={registry} props={props} anchor={anchor} />}
          renderGroup={(anchors) => <PluginMessageActionMenu registry={registry} props={props} anchors={anchors} />}
        >
          {children}
        </PluginMessageActionsProvider>
      </PluginMessageProvider>
    </PluginToolCardProvider>
  )
}
