import { createElement, type ComponentProps } from 'react'
import type { UiPluginContext } from '@pi-meme/plugin-sdk/ui'
import { SubagentsSettings } from './subagents-settings'

export function activate(context: UiPluginContext) {
  const dispose = [
    context.contribute({
      id: `${context.pluginId}:subagents`,
      slot: 'settings',
      render: (props) =>
        props.area === 'subagents' && props.subagentsProps
          ? createElement(SubagentsSettings, props.subagentsProps as ComponentProps<typeof SubagentsSettings>)
          : null,
    }),
  ]
  return async () => {
    for (const release of dispose.reverse()) await release()
  }
}
