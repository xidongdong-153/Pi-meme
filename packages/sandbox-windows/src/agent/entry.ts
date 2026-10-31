import { AccessSandbox } from '@pi-meme/pi-runtime/sdk/access-sandbox'

export function create(context: { registerSandbox: (factory: typeof AccessSandbox.create) => void }) {
  context.registerSandbox(AccessSandbox.create)
  return []
}
