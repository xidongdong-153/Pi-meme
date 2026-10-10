import { createElement, type ComponentProps } from 'react'
import type { UiPluginContext } from '@pi-meme/plugin-sdk/ui'
import { ContextUsageRing } from './context-usage-ring'
import { ModelPickerPopover } from './model-picker-popover'
import { ModelConfigSettings } from './model-config/model-config-settings'

export function activate(context: UiPluginContext) {
  const dispose = [
    context.contribute({
      id: `${context.pluginId}:context`,
      slot: 'status',
      render: (props) =>
        props.area === 'context' && props.contextProps
          ? createElement(ContextUsageRing, props.contextProps as ComponentProps<typeof ContextUsageRing>)
          : null,
    }),
    context.contribute({
      id: `${context.pluginId}:model`,
      slot: 'composer',
      render: (props) =>
        props.area === 'model' && props.modelPickerProps
          ? createElement(ModelPickerPopover, props.modelPickerProps as ComponentProps<typeof ModelPickerPopover>)
          : null,
    }),
    context.contribute({
      id: `${context.pluginId}:models`,
      slot: 'settings',
      render: (props) =>
        props.area === 'models' && props.modelSettingsProps
          ? createElement(ModelConfigSettings, props.modelSettingsProps as ComponentProps<typeof ModelConfigSettings>)
          : null,
    }),
  ]
  return async () => {
    for (const release of dispose.reverse()) await release()
  }
}
