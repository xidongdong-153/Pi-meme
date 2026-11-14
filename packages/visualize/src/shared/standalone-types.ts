import type { VisualizationDocument, VisualizationEnvironment, VisualizationState } from '@pi-meme/contracts/visualize'

export type StandalonePayload = {
  title: string
  html: string
  shell: string
  state: VisualizationState
  controls: VisualizationDocument['controls']
  assets: { core: string; echarts?: string }
  environment: VisualizationEnvironment
  storageKey: string
}
