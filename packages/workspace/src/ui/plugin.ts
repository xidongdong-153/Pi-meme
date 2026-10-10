import { createElement, type ComponentProps } from 'react'
import type { UiPluginContext } from '@pi-meme/plugin-sdk/ui'
import { Sidebar } from './sidebar/sidebar'
import { ProjectSelector } from './project-selector'

export function activate(context: UiPluginContext) {
  const dispose = [
    context.contribute({
      id: `${context.pluginId}:sidebar`,
      slot: 'sidebar',
      render: (props) =>
        props.area === 'sidebar' && props.sidebarProps
          ? createElement(Sidebar, props.sidebarProps as ComponentProps<typeof Sidebar>)
          : null,
    }),
    context.contribute({
      id: `${context.pluginId}:project-selector`,
      slot: 'composer',
      render: (props) =>
        props.area === 'project' && props.projectSelectorProps
          ? createElement(ProjectSelector, props.projectSelectorProps as ComponentProps<typeof ProjectSelector>)
          : null,
    }),
  ]
  return async () => {
    for (const release of dispose.reverse()) await release()
  }
}
