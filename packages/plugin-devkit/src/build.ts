import { mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import path from 'node:path'
import { build } from 'esbuild'
import { buildFacet } from '@earendil-works/chord/plugins'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import {
  chordArtifactFormat,
  chordModuleRegistryName,
  chordVersion,
  type ChordPluginArtifact,
} from '@pi-meme/plugin-runtime/chord-artifact'
import { parsePluginManifest } from '@pi-meme/plugin-sdk/manifest'
import { packPlugin, readPluginManifest } from '@pi-meme/plugin-runtime/package'
import { assertExternalManifest } from '@pi-meme/plugin-sdk/reserved'
import { toolchainDirectory } from './toolchain'

export async function buildPlugin(directory: string) {
  const manifest = parsePluginManifest(JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')))
  assertExternalManifest(manifest)
  const tools = await toolchainDirectory()
  const nodePaths = [path.join(directory, '.pi-meme-devkit/dist/node_modules'), path.join(tools, 'node_modules')]
  const trustedServer = manifest.piMeme.server?.trusted
  if (trustedServer) {
    if (trustedServer !== 'dist/server/chord-facets.json')
      throw new Error('DevKit 可信 Server 输出必须为 dist/server/chord-facets.json')
    const wrapper = path.resolve(directory, 'src/server/.chord-entry.ts')
    const module = path.resolve(directory, 'src/server/.chord-module.mjs')
    const compiled = await build({
      entryPoints: [path.resolve(directory, 'src/server/entry.ts')],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'node',
      target: 'node22.19',
      nodePaths,
      external: ['@earendil-works/chord', '@earendil-works/chord/*'],
      logLevel: 'silent',
    })
    await writeFile(module, compiled.outputFiles[0].contents, { flag: 'wx' })
    try {
      await writeFile(
        wrapper,
        `import { defineFacet, defineRegistry } from '@earendil-works/chord'
import { create } from './.chord-module.mjs'
export default defineFacet((_host, self) => self.contribute(defineRegistry(${JSON.stringify(chordModuleRegistryName)}, {version: 1}), {create}))`,
        { flag: 'wx' },
      )
      try {
        const root = await realpath(directory)
        const facet = await buildFacet(
          {
            name: manifest.name,
            dir: root,
            root,
            required: true,
            layout: 'directory',
            facets: { server: path.join(root, 'src/server/.chord-entry.ts') },
            dependencies: [],
            external: [],
          },
          'server',
          { platform: 'node', hostPackages: ['@earendil-works/chord', '@earendil-works/chord/context'] },
          BACKGROUND_CONTEXT,
        )
        if (facet.kind === 'failed') throw new Error(`Chord 构建失败：\n${facet.errors.join('\n')}`)
        const artifact: ChordPluginArtifact = {
          format: chordArtifactFormat,
          chordVersion,
          plugin: { id: manifest.name, version: manifest.version },
          source: facet.source,
          digest: facet.digest,
        }
        await mkdir(path.join(root, 'dist/server'), { recursive: true })
        await writeFile(path.join(root, trustedServer), `${JSON.stringify(artifact, null, 2)}\n`)
      } finally {
        await rm(wrapper, { force: true })
      }
    } finally {
      await rm(module, { force: true })
    }
  }
  for (const [source, output, browser] of [
    ['src/agent/entry.ts', manifest.piMeme.agent?.trusted, false],
    ['src/agent/restricted.ts', manifest.piMeme.agent?.restricted, false],
    ['src/server/restricted.ts', manifest.piMeme.server?.restricted, false],
    ['src/ui/entry.tsx', manifest.piMeme.ui, true],
  ] as const) {
    if (!output) continue
    const expected = source.replace(/^src\//, 'dist/').replace(/\.tsx?$/, '.js')
    if (output !== expected) throw new Error(`DevKit 输出必须为 ${expected}`)
    await build({
      entryPoints: [path.join(directory, source)],
      outfile: path.join(directory, output),
      bundle: true,
      nodePaths,
      format: 'esm',
      platform: browser ? 'browser' : 'node',
      target: browser ? 'es2022' : 'node22.19',
      jsx: 'automatic',
      loader: { '.css': 'text' },
      sourcemap: true,
      external: browser ? ['react', 'react-dom', 'react-dom/*', 'react/*'] : [],
      absWorkingDir: path.resolve(directory),
      logLevel: 'silent',
    })
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
