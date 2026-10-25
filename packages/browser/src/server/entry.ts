import type { BuiltinModuleContext, BuiltinModuleDescriptor } from '@pi-meme/contracts/builtin-module'
import type { BrowserDownload, BrowserWorkspace } from '@pi-meme/contracts/browser'
import { BrowserStore } from './store'

export const manifest: BuiltinModuleDescriptor = {
  name: '@pi-meme/browser',
  version: '0.0.0',
  piMeme: { sdkVersion: 3 },
}
export async function create(context: BuiltinModuleContext) {
  const store = new BrowserStore(context.dataDirectory)
  await store.initialize()
  context.registerHandlers({
    'browser:snapshot': () => store.snapshot(),
    'browser:settings': (value) => store.settings(value),
    'browser:permission': (value) => store.permission(value),
    'browser:history': (value) => store.history(value),
    'browser:download': (value) => store.download(value as BrowserDownload | string),
    'browser:clear-downloads': () => store.clearDownloads(),
    'browser:workspace': (owner) => store.workspace(String(owner)),
    'browser:save-workspace': (owner, value) => store.saveWorkspace(String(owner), value as BrowserWorkspace),
    'browser:rebind': (from, to) => store.rebind(String(from), String(to)),
  })
}
