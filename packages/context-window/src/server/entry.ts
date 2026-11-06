import type { BuiltinModule, BuiltinModuleDescriptor } from '@pi-meme/contracts/builtin-module'
import type { ContextWindowStore } from './store'

export const manifest: BuiltinModuleDescriptor = {
  name: '@pi-meme/context-window',
  version: '0.1.0',
  piMeme: { sdkVersion: 3, requires: ['host.context-window'] },
}

export const create: BuiltinModule['create'] = (context) => {
  const store = context.services.require<ContextWindowStore>('host.context-window')
  context.onDispose(() => store.dispose())
}
