import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import * as chat from '@pi-meme/chat/server/entry'
import * as workspace from '@pi-meme/workspace/server/entry'
import * as git from '@pi-meme/git/server/entry'
import * as models from '@pi-meme/models/server/entry'
import * as settings from '@pi-meme/settings/server/entry'
import * as interaction from '@pi-meme/pi-extensions/server/entry'
import * as mcp from '@pi-meme/mcp/server/entry'
import * as history from '@pi-meme/history/server/entry'
import * as usage from '@pi-meme/usage/server/entry'
import * as resources from '@pi-meme/resources/server/entry'
import * as sandbox from '@pi-meme/sandbox-macos/server/entry'
import * as permissions from '@pi-meme/permissions/server/entry'
import * as codemode from '@pi-meme/codemode/server/entry'
import * as subagents from '@pi-meme/subagents/server/entry'
import type { PluginHandlers, ServerPluginModule } from '@pi-meme/plugin-sdk/server'
import { PluginScope } from '@pi-meme/plugin-sdk/scope'

const modules = [
  chat,
  workspace,
  git,
  models,
  settings,
  interaction,
  mcp,
  history,
  usage,
  resources,
  sandbox,
  permissions,
  codemode,
  subagents,
]

export async function createBuiltinModules(dataRoot: string, contexts: Record<string, object>) {
  const services = { ...contexts }
  const handlers: PluginHandlers = {}
  const scope = new PluginScope()
  try {
    for (const module of modules) {
      const { manifest } = module
      const dataDirectory = path.join(dataRoot, 'plugin-data', encodeURIComponent(manifest.name))
      await mkdir(dataDirectory, { recursive: true })
      const instance = await (module as ServerPluginModule).create({
        pluginId: manifest.name,
        generation: 1,
        dataDirectory,
        services: {
          require: <T>(name: string) => {
            if (!manifest.piMeme.requires?.includes(name) || !Object.hasOwn(services, name))
              throw new Error(`内置模块所需服务不可用：${manifest.name} / ${name}`)
            return services[name] as T
          },
        },
        registerHandlers: (values) => {
          for (const [name, handler] of Object.entries(values)) {
            if (typeof handler !== 'function' || Object.hasOwn(handlers, name))
              throw new Error(`内置操作无效或重复：${name}`)
            handlers[name] = handler
          }
          return scope.own(() => {
            for (const name of Object.keys(values)) delete handlers[name]
          })
        },
        provide: (name, service) => {
          if (
            !manifest.piMeme.provides?.includes(name) ||
            Object.hasOwn(services, name) ||
            !service ||
            (typeof service !== 'object' && typeof service !== 'function')
          )
            throw new Error(`内置服务无效或重复：${name}`)
          services[name] = service as object
          return scope.own(() => {
            delete services[name]
          })
        },
        onDispose: (effect) => {
          scope.own(effect)
        },
      })
      if (instance?.dispose) scope.own(instance.dispose)
      for (const name of manifest.piMeme.provides ?? []) {
        if (!Object.hasOwn(services, name)) throw new Error(`内置模块未提供声明的服务：${name}`)
      }
    }
    return {
      services,
      handlers,
      diagnostics: () =>
        modules.map(({ manifest }) => ({ id: manifest.name, version: manifest.version, status: 'active' as const })),
      dispose: () => scope.dispose(),
    }
  } catch (cause) {
    await scope.dispose().catch(() => {})
    throw cause
  }
}
