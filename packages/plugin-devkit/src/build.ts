import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { build } from 'esbuild'
import { bundleFacets } from '@earendil-works/chord/bundler'
import { parsePluginManifest } from '@pi-meme/plugin-sdk/manifest'
import { packPlugin, readPluginManifest } from '@pi-meme/plugin-runtime/package'

export async function buildPlugin(directory: string) {
  const manifest = parsePluginManifest(JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')))
  for (const kind of ['server', 'agent', 'ui'] as const) {
    const output = manifest.piMeme[kind]
    if (!output) continue
    if (kind === 'server') {
      if (output !== 'dist/server/chord-facets.json')
        throw new Error('DevKit server 入口必须为 dist/server/chord-facets.json')
      const wrapper = path.resolve(directory, 'src/server/.chord-entry.ts')
      await writeFile(
        wrapper,
        `import { defineFacet, defineService } from '@earendil-works/chord'
import { create } from './entry'
export default defineFacet({ id: ${JSON.stringify(`module:${manifest.name}`)}, setup(env) {
  env.provide(defineService(${JSON.stringify(`pi-meme.plugin.module:${manifest.name}`)}, { local: true }), { create })
} })`,
      )
      try {
        await bundleFacets({
          plugin: { id: manifest.name, version: manifest.version },
          entries: { server: wrapper },
          outdir: path.resolve(directory, 'dist/server'),
          workingDirectory: path.resolve(directory),
          platform: 'node',
          external: [],
          sourceMap: true,
        })
      } finally {
        await rm(wrapper, { force: true })
      }
      continue
    }
    if (output !== `dist/${kind}/entry.js`) throw new Error(`DevKit ${kind} 入口必须为 dist/${kind}/entry.js`)
    await build({
      entryPoints: [path.join(directory, `src/${kind}/entry.${kind === 'ui' ? 'tsx' : 'ts'}`)],
      outfile: path.join(directory, output),
      bundle: true,
      format: 'esm',
      platform: kind === 'ui' ? 'browser' : 'node',
      target: kind === 'ui' ? 'es2022' : 'node22',
      jsx: 'automatic',
      loader: { '.css': 'text' },
      sourcemap: true,

      external: kind === 'ui' ? ['react', 'react-dom', 'react-dom/*', 'react/*'] : [],
      absWorkingDir: path.resolve(directory),
      logLevel: 'silent',
    })
  }
  return readPluginManifest(directory)
}

export async function validatePlugin(directory: string) {
  return readPluginManifest(directory)
}

export async function packagePlugin(directory: string, output: string) {
  const buffer = await packPlugin(directory)
  await mkdir(path.dirname(path.resolve(output)), { recursive: true })
  await writeFile(output, buffer)
  return path.resolve(output)
}
