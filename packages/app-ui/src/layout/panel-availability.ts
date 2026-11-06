import type { UiPanel, UiPanelRequirement, UiTarget } from '@pi-meme/plugin-sdk/ui'
import { panelAvailable } from './panel-layout'

/** value 仅保存当前 owner 最后确认的布尔值；loading/error 不冒充无数据。 */
export type PanelDataFact = {
  status: 'unknown' | 'loading' | 'ready' | 'error' | 'unsupported'
  value?: boolean
  error?: string
  revision?: string
}
export type PanelDataFacts = Partial<Record<UiPanelRequirement, PanelDataFact>>
export type PanelContentState = PanelDataFact['status'] | 'empty'

/** 数据条件只影响发现入口；作用域仍是打开和保留实例的硬门槛。 */
export function resolvePanelAvailability(panel: UiPanel, target: UiTarget, facts: PanelDataFacts = {}) {
  const hardAvailable = panelAvailable(panel, target)
  const requirements = (panel.requirements ?? []).map((requirement) => facts[requirement])
  const error = requirements.find((fact) => fact?.status === 'error')?.error
  const contentState: PanelContentState = !hardAvailable
    ? 'unsupported'
    : requirements.some((fact) => fact?.status === 'unsupported')
      ? 'unsupported'
      : requirements.some((fact) => fact?.status === 'error')
        ? 'error'
        : requirements.some((fact) => fact?.status === 'ready' && fact.value === false)
          ? 'empty'
          : requirements.some((fact) => fact?.status === 'loading')
            ? 'loading'
            : requirements.some((fact) => !fact || fact.status === 'unknown')
              ? 'unknown'
              : 'ready'
  return {
    launcherVisible:
      hardAvailable &&
      panel.launcher !== 'hidden' &&
      requirements.every((fact) => fact?.value === true && fact.status !== 'unsupported'),
    canExplicitOpen: hardAvailable,
    canRetain: hardAvailable,
    contentState,
    error,
  }
}
