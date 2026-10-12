import { readFile, symlink } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export async function createDevkitAppPackage(root: string, name: string) {
  const { createPlugin } = await import('@pi-meme/plugin-devkit/create')
  const { buildPlugin, packagePlugin } = await import('@pi-meme/plugin-devkit/build')
  const directory = path.join(root, name)
  await createPlugin(directory, name)
  const fixtureDirectory = typeof __dirname === 'string' ? __dirname : path.dirname(fileURLToPath(import.meta.url))
  await symlink(path.resolve(fixtureDirectory, '../../node_modules'), path.join(directory, 'node_modules'), 'dir')
  await buildPlugin(directory)
  const packed = await packagePlugin(directory, path.join(root, `${name}.pim`))
  return (await readFile(packed)).toString('base64')
}
