import type { HostApi } from './app-host'

export type BuiltinDisposer = () => void | Promise<void>
export type BuiltinHandlers = Record<string, (...args: unknown[]) => unknown | Promise<unknown>>
export type BuiltinModuleDescriptor = {
  name: string
  version: string
  description?: string
  piMeme: { sdkVersion: 3; server?: string; agent?: string; ui?: string; requires?: string[]; provides?: string[] }
}
export type BuiltinModuleContext = {
  pluginId: string
  generation: number
  dataDirectory: string
  readonly host: HostApi
  services: { require: <T>(name: string) => T }
  registerHandlers: (handlers: BuiltinHandlers) => BuiltinDisposer
  provide: <T>(name: string, service: T) => BuiltinDisposer
  onDispose: (disposer: BuiltinDisposer) => void
}
export type BuiltinModule = {
  manifest: BuiltinModuleDescriptor
  create: (
    context: BuiltinModuleContext,
  ) => void | { dispose?: BuiltinDisposer } | Promise<void | { dispose?: BuiltinDisposer }>
}
