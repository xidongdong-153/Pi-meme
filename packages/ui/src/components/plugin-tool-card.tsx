import { createContext, useContext, type ReactNode } from 'react'

const ToolCardContext = createContext<((tool: unknown) => ReactNode) | undefined>(undefined)

export function PluginToolCardProvider({
  render,
  children,
}: {
  render: (tool: unknown) => ReactNode
  children: ReactNode
}) {
  return <ToolCardContext.Provider value={render}>{children}</ToolCardContext.Provider>
}

export function PluginToolCard({ tool }: { tool: unknown }) {
  const render = useContext(ToolCardContext)
  return render ? <>{render(tool)}</> : null
}
