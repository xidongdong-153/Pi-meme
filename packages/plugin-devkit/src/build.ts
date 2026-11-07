import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { build } from 'esbuild'
import { parsePluginManifest } from '@pi-meme/plugin-sdk/manifest'
import { parseDeclarativePluginUi } from '@pi-meme/plugin-sdk/declarative-ui'
import { packPlugin, readPluginManifest } from '@pi-meme/plugin-runtime/package'
import { assertExternalManifest } from '@pi-meme/plugin-sdk/reserved'
import { toolchainDirectory } from './toolchain'

export async function buildPlugin(directory: string) {
  const manifest = parsePluginManifest(JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')))
  assertExternalManifest(manifest)
  const tools = await toolchainDirectory()
  const nodePaths = [path.join(directory, '.pi-meme-devkit/dist/node_modules'), path.join(tools, 'node_modules')]
  for (const [source, output] of [
    ['src/agent/restricted.ts', manifest.piMeme.agent?.restricted],
    ['src/server/restricted.ts', manifest.piMeme.server?.restricted],
  ] as const) {
    if (!output) continue
    const expected = source.replace(/^src\//, 'dist/').replace(/\.ts$/, '.js')
    if (output !== expected) throw new Error(`DevKit 输出必须为 ${expected}`)
    await build({
      entryPoints: [path.join(directory, source)],
      outfile: path.join(directory, output),
      bundle: true,
      nodePaths,
      format: 'esm',
      platform: 'node',
      target: 'node22.19',
      sourcemap: true,
      absWorkingDir: path.resolve(directory),
      logLevel: 'silent',
    })
  }
  if (manifest.piMeme.ui) {
    if (manifest.piMeme.ui !== 'dist/ui/entry.json') throw new Error('DevKit 声明式 UI 输出必须为 dist/ui/entry.json')
    const source = await readFile(path.join(directory, 'src/ui/entry.json'), 'utf8')
    const ui = parseDeclarativePluginUi(JSON.parse(source))
    await mkdir(path.join(directory, 'dist/ui'), { recursive: true })
    await writeFile(path.join(directory, manifest.piMeme.ui), `${JSON.stringify(ui, null, 2)}\n`)
  }
  return readPluginManifest(directory)
}
export async function validatePlugin(directory: string) {
  const manifest = await readPluginManifest(directory)
  assertExternalManifest(manifest)
  return manifest
}
export async function packagePlugin(directory: string, output: string) {
  await validatePlugin(directory)
  const buffer = await packPlugin(directory)
  await mkdir(path.dirname(path.resolve(output)), { recursive: true })
  await writeFile(output, buffer)
  return path.resolve(output)
}
