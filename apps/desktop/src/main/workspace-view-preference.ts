import path from 'node:path'
import { readJson, writeJson } from '@pi-meme/host/storage/files'

export function createWorkspaceViewPreference(userDataDir: string) {
  const file = path.join(userDataDir, 'workspace-view.json')
  let pending = Promise.resolve()

  return {
    async read() {
      await pending
      const value = await readJson<{ unified: boolean }>(file)
      if (value === undefined) return null
      if (typeof value?.unified !== 'boolean') throw new Error('完整视图配置无效')
      return value.unified
    },
    save(unified: boolean) {
      const write = pending.then(() => writeJson(file, { unified }))
      pending = write.catch(() => {})
      return write
    },
    flush: () => pending,
  }
}
