import { createElement, type ComponentProps } from 'react'
import type { UiPluginContext } from '@pi-meme/plugin-sdk/ui'
import { Conversation } from './conversation/conversation'
import { Composer } from './composer/composer'

export function activate(context: UiPluginContext) {
  const dispose = [
    context.contribute({
      id: `${context.pluginId}:chat`,
      slot: 'page',
      render: (props) =>
        props.area === 'chat' && props.conversationProps
          ? createElement(Conversation, props.conversationProps as ComponentProps<typeof Conversation>)
          : null,
    }),
    context.contribute({
      id: `${context.pluginId}:composer`,
      slot: 'composer',
      render: (props) =>
        props.area === 'composer' && props.composerProps
          ? createElement(Composer, props.composerProps as ComponentProps<typeof Composer>)
          : null,
    }),
  ]
  return async () => {
    for (const release of dispose.reverse()) await release()
  }
}
