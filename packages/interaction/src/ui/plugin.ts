import { createElement, type ComponentProps } from 'react'
import type { UiPluginContext } from '@pi-meme/plugin-sdk/ui'
import { ExtensionWidgets } from './extension-widgets'
import { ExtensionStatusBadges } from './extension-statuses'
import { ExtensionDialog } from './extension-dialog'
import { ExtensionNotices } from './extension-notices'

export function activate(context: UiPluginContext) {
  const dispose = [
    context.contribute({
      id: `${context.pluginId}:above`,
      slot: 'composer',
      render: (props) =>
        props.area === 'above' && props.widgetProps
          ? createElement(ExtensionWidgets, props.widgetProps as ComponentProps<typeof ExtensionWidgets>)
          : null,
    }),
    context.contribute({
      id: `${context.pluginId}:below`,
      slot: 'composer',
      render: (props) =>
        props.area === 'below' && props.widgetProps
          ? createElement(ExtensionWidgets, props.widgetProps as ComponentProps<typeof ExtensionWidgets>)
          : null,
    }),
    context.contribute({
      id: `${context.pluginId}:status`,
      slot: 'status',
      render: (props) =>
        props.area === 'status' && props.statusProps
          ? createElement(ExtensionStatusBadges, props.statusProps as ComponentProps<typeof ExtensionStatusBadges>)
          : null,
    }),
    context.contribute({
      id: `${context.pluginId}:dialog`,
      slot: 'page',
      render: (props) =>
        props.area === 'dialog' && props.dialogProps
          ? createElement(ExtensionDialog, {
              ...(props.dialogProps as ComponentProps<typeof ExtensionDialog>),
              key: String(props.dialogKey ?? 'dialog'),
            })
          : null,
    }),
    context.contribute({
      id: `${context.pluginId}:notices`,
      slot: 'page',
      render: (props) =>
        props.area === 'notices' && props.noticesProps
          ? createElement(ExtensionNotices, props.noticesProps as ComponentProps<typeof ExtensionNotices>)
          : null,
    }),
  ]
  return async () => {
    for (const release of dispose.reverse()) await release()
  }
}
