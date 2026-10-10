import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPlugin } from '@pi-meme/plugin-devkit/build'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../plugins')
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const directory = path.join(root, entry.name)
  const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')) as { piMeme?: unknown }
  if (manifest.piMeme) {
    await buildPlugin(directory)
    console.log(`插件构建完成：${entry.name}`)
  }
}
