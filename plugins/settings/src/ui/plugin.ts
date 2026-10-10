import { createElement, type ComponentProps } from 'react'
import type { UiPluginContext } from '@pi-meme/plugin-sdk/ui'
import { SettingsPage } from './settings-page'

export function activate(context: UiPluginContext) {
  const dispose = [
    context.contribute({
      id: `${context.pluginId}:settings`,
      slot: 'settings',
      render: (props) =>
        props.area === 'settings' && props.settingsProps
          ? createElement(SettingsPage, props.settingsProps as ComponentProps<typeof SettingsPage>)
          : null,
    }),
  ]
  return async () => {
    for (const release of dispose.reverse()) await release()
  }
}
