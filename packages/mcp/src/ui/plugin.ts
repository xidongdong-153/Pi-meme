import { createElement, type ComponentProps } from 'react'
import type { UiPluginContext } from '@pi-meme/plugin-sdk/ui'
import { McpSettings } from './mcp-settings'

export function activate(context: UiPluginContext) {
  const dispose = [
    context.contribute({
      id: `${context.pluginId}:mcp`,
      slot: 'settings',
      render: (props) =>
        props.area === 'mcp' && props.mcpSettingsProps
          ? createElement(McpSettings, props.mcpSettingsProps as ComponentProps<typeof McpSettings>)
          : null,
    }),
  ]
  return async () => {
    for (const release of dispose.reverse()) await release()
  }
}
