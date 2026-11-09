import type { BuiltinModuleContext, BuiltinModuleDescriptor } from '@pi-meme/contracts/builtin-module'
import type { MemoryServiceOptions } from '@pi-meme/contracts/memory'
import { MemoryService } from './service'

export const manifest: BuiltinModuleDescriptor = {
  name: '@pi-meme/memory',
  version: '0.0.0',
  piMeme: { sdkVersion: 3, requires: ['host.memory'], provides: ['host.memory.runtime'] },
}
export async function create(context: BuiltinModuleContext) {
  const options = context.services.require<Omit<MemoryServiceOptions, 'directory'>>('host.memory')
  const memory = new MemoryService({ ...options, directory: context.dataDirectory })
  await memory.init()
  context.provide('host.memory.runtime', memory)
  context.onDispose(() => memory.dispose())
}
