import { createElement, type ComponentProps } from 'react'
import type { UiPluginContext } from '@pi-meme/plugin-sdk/ui'
import { SessionTreePanel } from './session-tree-panel'

export function activate(context: UiPluginContext) {
  const dispose = [
    context.contribute({
      id: `${context.pluginId}:history`,
      slot: 'page',
      render: (props) =>
        props.area === 'history' && props.sessionTreeProps
          ? createElement(SessionTreePanel, props.sessionTreeProps as ComponentProps<typeof SessionTreePanel>)
          : null,
    }),
  ]
  return async () => {
    for (const release of dispose.reverse()) await release()
  }
}
