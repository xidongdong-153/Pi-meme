import { createElement, type ComponentProps } from 'react'
import type { UiPluginContext } from '@pi-meme/plugin-sdk/ui'
import { ProfileSettings } from './profile-settings'

export function activate(context: UiPluginContext) {
  const dispose = [
    context.contribute({
      id: `${context.pluginId}:profile`,
      slot: 'settings',
      render: (props) =>
        props.area === 'profile' && props.profileProps
          ? createElement(ProfileSettings, props.profileProps as ComponentProps<typeof ProfileSettings>)
          : null,
    }),
  ]
  return async () => {
    for (const release of dispose.reverse()) await release()
  }
}
