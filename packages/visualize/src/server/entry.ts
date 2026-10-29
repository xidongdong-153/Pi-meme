import type { BuiltinModuleContext, BuiltinModuleDescriptor } from '@pi-meme/contracts/builtin-module'

export const manifest: BuiltinModuleDescriptor = {
  name: '@pi-meme/visualize',
  version: '0.0.0',
  description: '生成和预览交互草图。',
  piMeme: { sdkVersion: 3, requires: ['host.visualize'] },
}
export function create(context: BuiltinModuleContext) {
  context.services.require('host.visualize')
}
