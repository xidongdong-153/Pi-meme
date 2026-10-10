import { createElement, type ComponentProps } from 'react'
import type { UiPluginContext } from '@pi-meme/plugin-sdk/ui'
import { GitPanel } from './git-panel'

export function activate(context: UiPluginContext) {
  const dispose = [
    context.contribute({
      id: `${context.pluginId}:git`,
      slot: 'page',
      render: (props) =>
        props.area === 'git' && props.gitProps
          ? createElement(GitPanel, props.gitProps as ComponentProps<typeof GitPanel>)
          : null,
    }),
  ]
  return async () => {
    for (const release of dispose.reverse()) await release()
  }
}
