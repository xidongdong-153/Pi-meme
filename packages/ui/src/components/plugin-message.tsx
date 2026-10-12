import * as React from 'react'
import { createContext, useContext, type ReactNode } from 'react'

export type PluginMessageSource = { ownerId?: string; generation?: number; customType: string }
type MessageRenderer = (message: unknown, source: PluginMessageSource, fallback: ReactNode) => ReactNode
const MessageContext = createContext<MessageRenderer | undefined>(undefined)

export function PluginMessageProvider({ render, children }: { render: MessageRenderer; children: ReactNode }) {
  return <MessageContext.Provider value={render}>{children}</MessageContext.Provider>
}

export function PluginMessage({
  message,
  ownerId,
  generation,
  customType,
  fallback,
}: PluginMessageSource & { message: unknown; fallback: ReactNode }) {
  const render = useContext(MessageContext)
  return <>{render ? render(message, { ownerId, generation, customType }, fallback) : fallback}</>
}
