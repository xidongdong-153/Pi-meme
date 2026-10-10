import type { UiPluginContext } from '@pi-meme/plugin-sdk/ui'

export function activate(context: UiPluginContext) {
  return context.contribute({
    id: `${context.pluginId}:settings`,
    slot: 'settings',
    render: (props) => (props.area === 'sandbox-macos' ? props.builtin?.[props.area] : null),
  })
}
