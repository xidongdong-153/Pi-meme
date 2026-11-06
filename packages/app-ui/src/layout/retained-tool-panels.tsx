import { useEffect, useRef, useState } from 'react'
import type { UiContributionProps, UiPanel } from '@pi-meme/plugin-sdk/ui'
import { ErrorBoundary } from '@pi-meme/ui/components/error-boundary'
import { panelsRetiredEvent, type PanelsRetiredDetail } from './panel-layout'

export type PanelOpenRequest = {
  intent: NonNullable<UiContributionProps['panelOpenIntent']>
  revision: number
}

type Pane = { session: string; panel: UiPanel; contribution: UiContributionProps }

/** 保留工具的 DOM 与实例；隐藏视图不参与布局和键盘焦点。 */
export function RetainedToolPanels({
  session,
  panels,
  tabs,
  active,
  visible,
  contribution,
  openRequests,
}: {
  session: string
  panels: UiPanel[]
  tabs: string[]
  active: string
  visible: boolean
  contribution: UiContributionProps
  openRequests?: Record<string, PanelOpenRequest>
}) {
  const [windowVisible, setWindowVisible] = useState(() => typeof document === 'undefined' || !document.hidden)
  useEffect(() => {
    const update = () => setWindowVisible(!document.hidden)
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])
  const retained = useRef(new Map<string, Pane>())
  const instance = useRef(0)
  const retired = useRef(new WeakSet<UiPanel>())
  const currentPanels = useRef({ panels, hostId: contribution.target.hostId })
  currentPanels.current = { panels, hostId: contribution.target.hostId }
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
    const retire = (event: Event) => {
      const detail = (event as CustomEvent<PanelsRetiredDetail>).detail
      for (const panel of currentPanels.current.panels) {
        if (
          currentPanels.current.hostId === detail.hostId &&
          detail.panels.some(({ id, generation }) => id === panel.id && generation === panel.generation)
        )
          retired.current.add(panel)
      }
      for (const [key, pane] of retained.current) {
        if (
          pane.contribution.target.hostId === detail.hostId &&
          detail.panels.some(({ id, generation }) => id === pane.panel.id && generation === pane.panel.generation)
        ) {
          retired.current.add(pane.panel)
          retained.current.delete(key)
        }
      }
      refresh((value) => value + 1)
    }
    window.addEventListener('pi-meme:sessions-deleted', remove)
    window.addEventListener('pi-meme:workspace-bound', bind)
    window.addEventListener(panelsRetiredEvent, retire)
    return () => {
      window.removeEventListener('pi-meme:sessions-deleted', remove)
      window.removeEventListener('pi-meme:workspace-bound', bind)
      window.removeEventListener(panelsRetiredEvent, retire)
    }
  }, [])
  for (const [key, value] of retained.current) {
    if (
      value.session === session &&
      (!tabs.includes(value.panel.id) ||
        !panels.some((panel) => panel.id === value.panel.id && panel.generation === value.panel.generation))
    )
      retained.current.delete(key)
  }
  for (const panel of panels) {
    if (retired.current.has(panel)) continue
    const key =
      [...retained.current].find(
        ([, pane]) =>
          pane.session === session && pane.panel.id === panel.id && pane.panel.generation === panel.generation,
      )?.[0] ?? JSON.stringify([session, panel.id, panel.generation ?? 0, ++instance.current])
    if (
      tabs.includes(panel.id) &&
      ((windowVisible && visible && contribution.visible !== false && active === panel.id) || retained.current.has(key))
    )
      retained.current.set(key, {
        session,
        panel,
        contribution: {
          ...contribution,
          panelOpenIntent: openRequests?.[panel.id]?.intent ?? 'restore',
          panelOpenRevision: openRequests?.[panel.id]?.revision ?? 0,
        },
      })
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
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {pane.panel.render({
                ...pane.contribution,
                visible:
                  windowVisible &&
                  contribution.visible !== false &&
                  visible &&
                  pane.session === session &&
                  pane.panel.id === active &&
                  panels.some((panel) => panel.id === pane.panel.id),
              })}
            </div>
          </ErrorBoundary>
        </div>
      ))}
    </>
  )
}
