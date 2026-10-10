import { createElement, type ComponentProps } from 'react'
import type { UiPluginContext } from '@pi-meme/plugin-sdk/ui'
import { SkillsSettings } from './skills-settings'
import { ExtensionsSettings } from './extensions-settings'

export function activate(context: UiPluginContext) {
  const dispose = [
    context.contribute({
      id: `${context.pluginId}:skills`,
      slot: 'settings',
      render: (props) =>
        props.area === 'skills' && props.skillsProps
          ? createElement(SkillsSettings, props.skillsProps as ComponentProps<typeof SkillsSettings>)
          : null,
    }),
    context.contribute({
      id: `${context.pluginId}:extensions`,
      slot: 'settings',
      render: (props) =>
        props.area === 'extensions' && props.extensionsProps
          ? createElement(ExtensionsSettings, props.extensionsProps as ComponentProps<typeof ExtensionsSettings>)
          : null,
    }),
  ]
  return async () => {
    for (const release of dispose.reverse()) await release()
  }
}
