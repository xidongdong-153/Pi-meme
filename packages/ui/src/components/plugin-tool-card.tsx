import * as React from 'react'
import { createContext, useContext, type ReactNode } from 'react'
import { usePublicPluginSession } from './plugin-message'

export type PluginToolCardSource = { ownerId?: string; generation?: number; policyHash?: string; toolName?: string }
type ToolCardRenderer = (tool: unknown, source: PluginToolCardSource) => ReactNode
const ToolCardContext = createContext<ToolCardRenderer | undefined>(undefined)

export function PluginToolCardProvider({ render, children }: { render: ToolCardRenderer; children: ReactNode }) {
  return <ToolCardContext.Provider value={render}>{children}</ToolCardContext.Provider>
}

export function PluginToolCard({
  tool,
  ownerId,
  generation,
  policyHash,
  toolName,
}: { tool: unknown } & PluginToolCardSource) {
  const render = useContext(ToolCardContext)
  const publicSession = usePublicPluginSession()
  return render && publicSession ? <>{render(tool, { ownerId, generation, policyHash, toolName })}</> : null
}
