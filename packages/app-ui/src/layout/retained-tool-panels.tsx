import { useEffect, useRef, useState } from 'react'
import type { UiContributionProps, UiPanel } from '@pi-meme/plugin-sdk/ui'
import { ErrorBoundary } from '@pi-meme/ui/components/error-boundary'

type Pane = { session: string; panel: UiPanel; contribution: UiContributionProps }

/** 保留工具的 DOM 与实例；隐藏视图不参与布局和键盘焦点。 */
export function RetainedToolPanels({
  session,
  panels,
  tabs,
  active,
  visible,
  contribution,
}: {
  session: string
  panels: UiPanel[]
  tabs: string[]
  active: string
  visible: boolean
  contribution: UiContributionProps
}) {
  const retained = useRef(new Map<string, Pane>())
  const [, refresh] = useState(0)
  useEffect(() => {
    const remove = (event: Event) => {
      const detail = (event as CustomEvent<{ hostId: string; sessionIds: string[] }>).detail
      for (const [key, pane] of retained.current) {
        if (
          pane.contribution.target.hostId === detail.hostId &&
          detail.sessionIds.includes(pane.contribution.target.session?.sessionId ?? '')
        )
          retained.current.delete(key)
      }
      refresh((value) => value + 1)
    }
    const bind = (event: Event) => {
      const detail = (event as CustomEvent<{ hostId: string; from: string; to: string }>).detail
      const from = `pi-meme:panels:v2:${JSON.stringify([detail.hostId, detail.from])}`
      const to = `pi-meme:panels:v2:${JSON.stringify([detail.hostId, detail.to])}`
      for (const pane of retained.current.values()) if (pane.session === from) pane.session = to
    }
    window.addEventListener('pi-meme:sessions-deleted', remove)
    window.addEventListener('pi-meme:workspace-bound', bind)
    return () => {
      window.removeEventListener('pi-meme:sessions-deleted', remove)
      window.removeEventListener('pi-meme:workspace-bound', bind)
    }
  }, [])
  for (const [key, value] of retained.current) {
    if (
      value.session === session &&
      (!tabs.includes(value.panel.id) ||
        panels.some((panel) => panel.id === value.panel.id && panel.generation !== value.panel.generation))
    )
      retained.current.delete(key)
  }
  for (const panel of panels) {
    const key =
      [...retained.current].find(
        ([, pane]) =>
          pane.session === session && pane.panel.id === panel.id && pane.panel.generation === panel.generation,
      )?.[0] ?? JSON.stringify([session, panel.id, panel.generation ?? 0])
    if (tabs.includes(panel.id) && (active === panel.id || retained.current.has(key)))
      retained.current.set(key, { session, panel, contribution })
  }
  return (
    <>
      {[...retained.current].map(([key, pane]) => (
        <div
          key={key}
          hidden={
            !(
              visible &&
              pane.session === session &&
              pane.panel.id === active &&
              panels.some((panel) => panel.id === pane.panel.id)
            )
          }
          inert={
            !(
              visible &&
              pane.session === session &&
              pane.panel.id === active &&
              panels.some((panel) => panel.id === pane.panel.id)
            )
          }
          className="min-h-0 min-w-0 flex-1 flex-col [&:not([hidden])]:flex"
        >
          <ErrorBoundary fallbackTitle={`面板渲染失败：${pane.panel.title}`}>
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">{pane.panel.render(pane.contribution)}</div>
          </ErrorBoundary>
        </div>
      ))}
    </>
  )
}
