import { access, constants, readFile } from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parseDeclarativePluginUi } from '@pi-meme/plugin-sdk/declarative-ui'
import ts from 'typescript'
import { parsePluginManifest } from '@pi-meme/plugin-sdk/manifest'
import { assertExternalManifest } from '@pi-meme/plugin-sdk/reserved'
import { validatePluginResources } from '@pi-meme/plugin-runtime/package'
import { diagnosticHost, toolchainDirectory } from './toolchain'

export async function doctor() {
  const tools = await toolchainDirectory()
  const info = JSON.parse(await readFile(path.join(tools, 'toolchain.json'), 'utf8')) as {
    sdkVersion: number
    platform: string
    arch: string
    node: string
  }
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 22 || (major === 22 && minor < 19)) throw new Error('构建插件需要 Node.js >=22.19.0')
  if (info.sdkVersion !== 4 || info.platform !== process.platform || info.arch !== process.arch)
    throw new Error(`工具包不匹配：需要 SDK 4、${process.platform}/${process.arch}，请使用当前 Host 随附的工具包`)
  const binary = path.join(
    tools,
    'node_modules/@esbuild',
    `${info.platform}-${info.arch}`,
    info.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild',
  )
  await access(binary, info.platform === 'win32' ? constants.F_OK : constants.X_OK)
  for (const file of [
    'cli.mjs',
    'templates/agent.ts.template',
    'node_modules/typescript/lib/typescript.js',
    'node_modules/@pi-meme/plugin-sdk/src/restricted.d.ts',
    'node_modules/@pi-meme/plugin-sdk/src/ui.d.ts',
  ])
    await access(path.join(tools, file))
  const esbuild = (await import(path.join(tools, 'node_modules/esbuild/lib/main.js'))) as typeof import('esbuild')
  await esbuild.transform('const value: number = 1', { loader: 'ts' })
  return { sdkVersion: info.sdkVersion, node: process.versions.node, platform: info.platform, arch: info.arch }
}

export async function checkPlugin(directory: string) {
  const root = path.resolve(directory)
  const manifest = parsePluginManifest(JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')))
  assertExternalManifest(manifest)
  await validatePluginResources(root, manifest)
  const tools = await toolchainDirectory()
  for (const skill of manifest.piMeme.resources?.skills ?? []) {
    try {
      await promisify(execFile)(process.execPath, [
        path.join(tools, 'scripts/quick-validate.mjs'),
        path.join(root, skill),
      ])
    } catch (cause) {
      const error = cause as Error & { stderr?: string }
      throw new Error(`技能检查失败：${skill}；${error.stderr?.trim() || error.message}`, { cause })
    }
  }
  const sources = [
    [
      'server.restricted',
      manifest.piMeme.server?.restricted,
      'src/server/restricted.ts',
      'restricted',
      'RestrictedServerContext',
    ],
    [
      'agent.restricted',
      manifest.piMeme.agent?.restricted,
      'src/agent/restricted.ts',
      'restricted',
      'RestrictedAgentContext',
    ],
  ].filter((entry) => entry[1])
  const checks: string[] = []
  for (const [kind, output, source, module, type] of sources) {
    const expected =
      kind === 'server.trusted'
        ? 'dist/server/chord-facets.json'
        : source!.replace('src/', 'dist/').replace(/\.tsx?$/, '.js')
    if (output !== expected) throw new Error(`${kind} 的 DevKit 输出必须为 ${expected}`)
    await access(path.join(root, source!))
    const restricted = kind!.endsWith('.restricted')
    checks.push(
      `import type { ${type} as Type${checks.length} } from '@pi-meme/plugin-sdk/${module}'\nexport const check${checks.length}: ${restricted ? `{ ${kind!.startsWith('server') ? 'create' : 'activate'}: (context: Type${checks.length}) => unknown }` : `Type${checks.length}`} = null as unknown as typeof import('./${source!.replace(/^src\//, '').replace(/\.tsx?$/, '')}')`,
    )
  }
  if (sources.length) {
    const configFile = path.join(root, 'tsconfig.json')
    const config = ts.readConfigFile(configFile, ts.sys.readFile)
    if (config.error) throw new Error(ts.formatDiagnosticsWithColorAndContext([config.error], diagnosticHost))
    const parsed = ts.parseJsonConfigFileContent(
      config.config,
      ts.sys,
      root,
      { noEmit: true, noCheck: false },
      configFile,
    )
    if (parsed.errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(parsed.errors, diagnosticHost))
    const virtual = path.join(root, 'src/.pi-meme-entry-check.ts')
    const host = ts.createCompilerHost(parsed.options)
    const getSourceFile = host.getSourceFile.bind(host)
    host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) =>
      file === virtual
        ? ts.createSourceFile(file, checks.join('\n'), languageVersion, true)
        : getSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile)
    const program = ts.createProgram(
      [...parsed.fileNames, ...sources.map((entry) => path.join(root, entry[2]!)), virtual],
      parsed.options,
      host,
    )
    const diagnostics = ts.getPreEmitDiagnostics(program)
    if (diagnostics.length)
      throw new Error(`类型检查失败：\n${ts.formatDiagnosticsWithColorAndContext(diagnostics, diagnosticHost)}`)
  }
  if (manifest.piMeme.ui) {
    if (manifest.piMeme.ui !== 'dist/ui/entry.json') throw new Error('DevKit 声明式 UI 输出必须为 dist/ui/entry.json')
    parseDeclarativePluginUi(JSON.parse(await readFile(path.join(root, 'src/ui/entry.json'), 'utf8')))
  }
  return {
    name: manifest.name,
    sdkVersion: 4,
    entries: sources.length + Number(Boolean(manifest.piMeme.ui)),
    resources: manifest.piMeme.resources ?? {},
  }
}
