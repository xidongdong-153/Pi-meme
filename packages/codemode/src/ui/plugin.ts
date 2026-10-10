import { createElement, type ComponentProps } from 'react'
import type { UiPluginContext } from '@pi-meme/plugin-sdk/ui'
import { ToolExecutionSettingsPanel } from './tool-execution-settings'

export function activate(context: UiPluginContext) {
  const dispose = [
    context.contribute({
      id: `${context.pluginId}:tools`,
      slot: 'settings',
      render: (props) =>
        props.area === 'tools' && props.toolsProps
          ? createElement(
              ToolExecutionSettingsPanel,
              props.toolsProps as ComponentProps<typeof ToolExecutionSettingsPanel>,
            )
          : null,
    }),
  ]
  return async () => {
    for (const release of dispose.reverse()) await release()
  }
}
