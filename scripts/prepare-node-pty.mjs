import { chmod, access } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'

export async function prepareNodePty(directory) {
  if (process.platform !== 'darwin') return
  for (const folder of [`prebuilds/${process.platform}-${process.arch}`, 'build/Release']) {
    const helper = path.join(directory, folder, 'spawn-helper')
    try {
      await access(helper)
      await chmod(helper, 0o755)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
}

if (process.argv[1]?.endsWith('prepare-node-pty.mjs')) {
  const require = createRequire(new URL('../packages/host/package.json', import.meta.url))
  await prepareNodePty(path.dirname(require.resolve('node-pty/package.json')))
}
