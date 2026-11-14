import type { VisualizationEnvironment, VisualizationState } from '@pi-meme/contracts/visualize'
import type { ECharts, EChartsOption } from 'echarts'

export type VisualizationCapture = { svg: string; width: number; height: number }

export type VisualizationRuntimeApi = {
  getState: () => VisualizationState
  setState: (patch: VisualizationState) => Promise<VisualizationState>
  subscribe: (listener: (state: VisualizationState) => void) => () => void
  getEnvironment: () => VisualizationEnvironment
  subscribeEnvironment: (listener: (environment: VisualizationEnvironment) => void) => () => void
  createChart: (element: HTMLElement, option: EChartsOption) => ECharts
  refresh?: () => void
}

declare global {
  interface Window {
    piVisualize: VisualizationRuntimeApi
    lucide?: typeof import('lucide')
    echarts?: typeof import('echarts')
    __piVisualizeCapture?: () => Promise<VisualizationCapture>
  }
}
