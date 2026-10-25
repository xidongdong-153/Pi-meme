import type { BuiltinModuleContext, BuiltinModuleDescriptor } from '@pi-meme/contracts/builtin-module'
import { ScheduleService } from './service'

export const manifest: BuiltinModuleDescriptor = {
  name: '@pi-meme/schedules',
  version: '0.0.0',
  piMeme: { sdkVersion: 3, requires: ['host.schedules'], provides: ['host.schedules.runtime'] },
}
export async function create(context: BuiltinModuleContext) {
  const options = context.services.require<{ hostId: string; onError: (cause: unknown) => void }>('host.schedules')
  const service = new ScheduleService({ ...options, directory: context.dataDirectory })
  await service.init()
  context.provide('host.schedules.runtime', service)
  context.onDispose(() => service.dispose())
}
