import { createElement, type ComponentProps } from 'react'
import type { UiPluginContext } from '@pi-meme/plugin-sdk/ui'
import { AgentAccessSelector } from './agent-access-selector'
import { AccessSettings } from './access-settings'

export function activate(context: UiPluginContext) {
  const dispose = [
    context.contribute({
      id: `${context.pluginId}:selector`,
      slot: 'composer',
      render: (props) =>
        props.area === 'access' && props.accessProps
          ? createElement(AgentAccessSelector, props.accessProps as ComponentProps<typeof AgentAccessSelector>)
          : null,
    }),
    context.contribute({
      id: `${context.pluginId}:access`,
      slot: 'settings',
      render: (props) =>
        props.area === 'access' && props.defaultAccessProps
          ? createElement(AccessSettings, props.defaultAccessProps as ComponentProps<typeof AccessSettings>)
          : null,
    }),
  ]
  return async () => {
    for (const release of dispose.reverse()) await release()
  }
}
