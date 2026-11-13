import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { BuiltScript } from '@earendil-works/chord/plugins'
import type { PluginManifest } from '@pi-meme/plugin-sdk/manifest'

export const chordVersion = '1.5.2'
export const chordArtifactFormat = 'pi-meme-chord-plugin-v1'
export const chordModuleRegistryName = 'pi-meme.plugin.modules'

export type ChordPluginArtifact = {
  format: typeof chordArtifactFormat
  chordVersion: typeof chordVersion
  plugin: { id: string; version: string }
  source: string
  digest: string
}

export async function readChordArtifact(file: string, manifest: Pick<PluginManifest, 'name' | 'version'>) {
  const artifact = JSON.parse(await readFile(file, 'utf8')) as Partial<ChordPluginArtifact> | null
  if (
    !artifact ||
    typeof artifact !== 'object' ||
    Array.isArray(artifact) ||
    artifact.format !== chordArtifactFormat ||
    artifact.chordVersion !== chordVersion
  )
    throw new Error('unsupported-chord: 可信 Server 必须使用 Chord 1.5.2 DevKit 重建')
  if (artifact.plugin?.id !== manifest.name || artifact.plugin?.version !== manifest.version)
    throw new Error('Chord 构建产物与插件身份或版本不匹配')
  if (
    typeof artifact.source !== 'string' ||
    !artifact.source ||
    typeof artifact.digest !== 'string' ||
    createHash('sha256').update(artifact.source).digest('hex') !== artifact.digest
  )
    throw new Error('Chord 构建脚本或摘要无效')
  return {
    kind: 'script',
    plugin: manifest.name,
    facet: 'server',
    source: artifact.source,
    digest: artifact.digest,
    inputs: [],
    copied: [],
    assets: [],
  } satisfies BuiltScript
}
