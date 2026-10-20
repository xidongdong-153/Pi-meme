import { createContext, Fragment, useContext, useMemo, type ReactNode } from 'react'
import type { UiMessageActionSubject } from '@pi-meme/contracts/plugin-ui-data'
import { usePublicPluginSession } from './plugin-message'

export type MessageActionAnchor = Omit<UiMessageActionSubject, 'refs' | 'revision'> & {
  entries: readonly { id: string; revision: string }[]
  label?: string
}
type Renderer = (anchor: MessageActionAnchor) => ReactNode
type GroupRenderer = (anchors: readonly MessageActionAnchor[]) => ReactNode
type Renderers = { render: Renderer; renderGroup?: GroupRenderer }
const Context = createContext<Renderers | null>(null)

export function PluginMessageActionsProvider({
  render,
  renderGroup,
  children,
}: {
  render: Renderer | null
  renderGroup?: GroupRenderer
  children: ReactNode
}) {
  const value = useMemo(() => (render ? { render, renderGroup } : null), [render, renderGroup])
  return <Context.Provider value={value}>{children}</Context.Provider>
}

export function PluginMessageActions(props: MessageActionAnchor) {
  const renderer = useContext(Context)
  const publicSession = usePublicPluginSession()
  return <>{publicSession ? renderer?.render(props) : null}</>
}

export function PluginMessageActionsGroup({ anchors }: { anchors: readonly MessageActionAnchor[] }) {
  const renderer = useContext(Context)
  const publicSession = usePublicPluginSession()
  if (!publicSession || !renderer || !anchors.length) return null
  if (renderer.renderGroup) return <>{renderer.renderGroup(anchors)}</>
  return (
    <>
      {anchors.map((anchor) => (
        <Fragment key={JSON.stringify([anchor.role, anchor.toolCallId, anchor.entries, anchor.source])}>
          {renderer.render(anchor)}
        </Fragment>
      ))}
    </>
  )
}
