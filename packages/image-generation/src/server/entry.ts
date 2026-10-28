import type { BuiltinModuleContext, BuiltinModuleDescriptor } from '@pi-meme/contracts/builtin-module'
import type { ImageGenerationService } from './service'

export const manifest: BuiltinModuleDescriptor = {
  name: '@pi-meme/image-generation',
  version: '0.0.0',
  piMeme: { sdkVersion: 3, requires: ['host.image-generation'] },
}

export function create(context: BuiltinModuleContext) {
  const service = context.services.require<ImageGenerationService>('host.image-generation')
  context.onDispose(() => service.dispose())
}
