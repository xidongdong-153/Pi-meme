import * as React from 'react'
import { createContext, useContext, type ReactNode } from 'react'

export type PluginMessageSource = { ownerId?: string; generation?: number; policyHash?: string; customType: string }
type MessageRenderer = (message: unknown, source: PluginMessageSource, fallback: ReactNode) => ReactNode
const MessageContext = createContext<MessageRenderer | undefined>(undefined)
const PublicSessionContext = createContext(true)

/** 没有正式会话引用的独立只读视图只使用原生展示，不借用外层会话目标。 */
export function PluginConversationScope({ publicSession, children }: { publicSession: boolean; children?: ReactNode }) {
  const parent = useContext(PublicSessionContext)
  return <PublicSessionContext.Provider value={parent && publicSession}>{children}</PublicSessionContext.Provider>
}

export function usePublicPluginSession() {
  return useContext(PublicSessionContext)
}

export function PluginMessageProvider({ render, children }: { render: MessageRenderer; children: ReactNode }) {
  return <MessageContext.Provider value={render}>{children}</MessageContext.Provider>
}

export function PluginMessage({
  message,
  ownerId,
  generation,
  policyHash,
  customType,
  fallback,
}: PluginMessageSource & { message: unknown; fallback: ReactNode }) {
  const render = useContext(MessageContext)
  const publicSession = usePublicPluginSession()
  return (
    <>
      {render && publicSession ? render(message, { ownerId, generation, policyHash, customType }, fallback) : fallback}
    </>
  )
}
