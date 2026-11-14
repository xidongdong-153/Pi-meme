import type { BuiltinModuleContext, BuiltinModuleDescriptor } from '@pi-meme/contracts/builtin-module'

export const manifest: BuiltinModuleDescriptor = {
  name: '@pi-meme/visualize',
  version: '0.0.0',
  description: '生成可视化，支持图表、模拟、交互讲解与 UI 预览。',
  piMeme: { sdkVersion: 3, requires: ['host.visualize'] },
}
export function create(context: BuiltinModuleContext) {
  context.services.require('host.visualize')
}
