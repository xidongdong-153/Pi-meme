import * as React from 'react'
import { createContext, useContext, type ReactNode } from 'react'

export type PluginToolCardSource = { ownerId?: string; generation?: number; toolName?: string }
type ToolCardRenderer = (tool: unknown, source: PluginToolCardSource) => ReactNode
const ToolCardContext = createContext<ToolCardRenderer | undefined>(undefined)

export function PluginToolCardProvider({ render, children }: { render: ToolCardRenderer; children: ReactNode }) {
  return <ToolCardContext.Provider value={render}>{children}</ToolCardContext.Provider>
}

export function PluginToolCard({ tool, ownerId, generation, toolName }: { tool: unknown } & PluginToolCardSource) {
  const render = useContext(ToolCardContext)
  return render ? <>{render(tool, { ownerId, generation, toolName })}</> : null
}
