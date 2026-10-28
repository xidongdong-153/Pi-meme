import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MemoryCredentialStorage } from '@pi-meme/pi-runtime/secure-store'
import { ImageConfigStore } from '../src/server/config-store'

export const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=',
  'base64',
)
export async function imageFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-image-test-'))
  const credentials = new MemoryCredentialStorage()
  const store = new ImageConfigStore(path.join(root, 'image-generation.json'), credentials)
  return {
    root,
    credentials,
    store,
    save: async (baseUrl = 'https://example.com/v1', id = 'first') =>
      store.save({
        revision: (await store.snapshot()).revision,
        model: { id, name: id, baseUrl, model: 'image-model', size: 'auto', quality: 'auto' },
        apiKey: 'image-test-secret',
      }),
    dispose: () => rm(root, { recursive: true, force: true }),
  }
}
