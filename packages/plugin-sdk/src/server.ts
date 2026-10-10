import type { Disposer } from './scope'

export type PluginHandler = (...args: unknown[]) => unknown | Promise<unknown>
export type PluginHandlers = Record<string, PluginHandler>
export type PluginServices = { require: <T>(name: string) => T }

export type ServerPluginContext = {
  pluginId: string
  generation: number
  dataDirectory: string
  services: PluginServices
  registerHandlers: (handlers: PluginHandlers) => Disposer
  provide: <T>(name: string, service: T) => Disposer
  onDispose: (disposer: Disposer) => void
}

export type ServerPluginInstance = { dispose?: Disposer }
export type ServerPluginModule = {
  create: (context: ServerPluginContext) => void | ServerPluginInstance | Promise<void | ServerPluginInstance>
}
