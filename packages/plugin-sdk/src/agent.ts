import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'

export type AgentPluginModule = { default: ExtensionFactory }
export type AgentPluginEntry = { pluginId: string; generation: number; path: string }
export type InteractionPluginContext = {
  registerInteractionPolicy: (enabled: boolean) => void
  requestUserInput: (
    questions: import('@pi-meme/contracts/user-input').UserInputQuestion[],
    signal?: AbortSignal,
  ) => Promise<import('@pi-meme/contracts/user-input').UserInputResult>
}
