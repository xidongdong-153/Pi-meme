import { cp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parsePluginManifest, type PluginManifest } from '@pi-meme/plugin-sdk/manifest'
import { assertExternalManifest } from '@pi-meme/plugin-sdk/reserved'
import { toolchainDirectory } from './toolchain'

/** 只准备工程自带工具，不重建业务源码和配置。 */
export async function preparePluginTools(directory: string) {
  const manifest = parsePluginManifest(JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')))
  assertExternalManifest(manifest)
  const tools = await toolchainDirectory()
  const target = path.resolve(directory, '.pi-meme-devkit/dist')
  const existing = await realpath(target).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === 'ENOENT') return undefined
    throw cause
  })
  if ((await realpath(tools)) !== existing) await cp(tools, target, { recursive: true })
  await writeFile(
    path.join(directory, '.pi-meme-devkit/cli.mjs'),
    await readFile(path.join(tools, 'templates/devkit.mjs.template')),
    { flag: 'wx' },
  ).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code !== 'EEXIST') throw cause
  })
  return target
}

export type PluginRuntimeOption = 'none' | 'trusted' | 'restricted' | 'both'
export type CreatePluginOptions = {
  agent?: PluginRuntimeOption
  server?: PluginRuntimeOption
  ui?: 'none' | 'panel' | 'page'
  resources?: Array<'skills' | 'themes' | 'assets'>
  displayName?: string
}

export async function createPlugin(directory: string, name: string, options: CreatePluginOptions = {}) {
  const explicit = ['agent', 'server', 'ui', 'resources'].some((key) => key in options)
  const agent = options.agent ?? (explicit ? 'none' : 'restricted')
  const server = options.server ?? (explicit ? 'none' : 'restricted')
  const ui = options.ui ?? (explicit ? 'none' : 'panel')
  for (const value of [agent, server])
    if (!['none', 'trusted', 'restricted', 'both'].includes(value)) throw new Error(`入口类型无效：${value}`)
  if (!['none', 'panel', 'page'].includes(ui)) throw new Error(`UI 类型无效：${ui}`)
  const resources = options.resources ?? []
  if (resources.some((value) => !['skills', 'themes', 'assets'].includes(value))) throw new Error('资源类型无效')
  const skillName = name
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64)
    .replace(/-$/, '')
  const displayName = options.displayName ?? name
  const entries = (kind: 'agent' | 'server', value: PluginRuntimeOption) =>
    value === 'none'
      ? undefined
      : {
          ...(value === 'trusted' || value === 'both'
            ? { trusted: kind === 'server' ? 'dist/server/chord-facets.json' : 'dist/agent/entry.js' }
            : {}),
          ...(value === 'restricted' || value === 'both' ? { restricted: `dist/${kind}/restricted.js` } : {}),
        }
  const hasRestricted = [agent, server].some((value) => value === 'restricted' || value === 'both')
  const manifest: PluginManifest = parsePluginManifest({
    name,
    version: '0.1.0',
    type: 'module',
    description: `${displayName}插件。`,
    piMeme: {
      sdkVersion: 3,
      display: { name: displayName, ...(resources.includes('assets') ? { icon: 'assets/icon.svg' } : {}) },
      ...(agent !== 'none' ? { agent: entries('agent', agent) } : {}),
      ...(server !== 'none' ? { server: entries('server', server) } : {}),
      ...(ui !== 'none' ? { ui: 'dist/ui/entry.js' } : {}),
      ...(resources.length
        ? {
            resources: {
              ...(resources.includes('skills') ? { skills: [`skills/${skillName}`] } : {}),
              ...(resources.includes('themes') ? { themes: ['themes/custom.json'] } : {}),
              ...(resources.includes('assets') ? { assets: ['assets'] } : {}),
            },
          }
        : {}),
      ...(hasRestricted || ui !== 'none'
        ? {
            permissions: {
              ...(hasRestricted ? { restricted: { maxAccess: 'read-only', capabilities: [] } } : {}),
              ...(ui !== 'none' ? { ui: ui === 'page' ? ['navigation.pages'] : [] } : {}),
            },
          }
        : {}),
    },
  })
  assertExternalManifest(manifest)
  const tools = await toolchainDirectory()
  const files: Record<string, string> = {
    'package.json': `${JSON.stringify(
      {
        ...manifest,
        ...(agent !== 'none' || server !== 'none' || ui !== 'none'
          ? {
              peerDependencies: {
                '@pi-meme/plugin-sdk': '^0.1.0',
                ...(ui !== 'none' ? { react: '^19.3.0' } : {}),
              },
              peerDependenciesMeta: {
                '@pi-meme/plugin-sdk': { optional: true },
                ...(ui !== 'none' ? { react: { optional: true } } : {}),
              },
            }
          : {}),
        scripts: {
          'type-check': 'node .pi-meme-devkit/cli.mjs check .',
          build: 'node .pi-meme-devkit/cli.mjs build .',
          validate: 'node .pi-meme-devkit/cli.mjs validate .',
          pack: `node .pi-meme-devkit/cli.mjs pack . ../${name.split('/').at(-1)}.pim`,
        },
      },
      null,
      2,
    )}\n`,
    'tsconfig.json': `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          jsx: 'react-jsx',
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          typeRoots: ['.pi-meme-devkit/dist/node_modules/@types'],
          types: ui !== 'none' ? ['node', 'react'] : ['node'],
          paths: {
            '@pi-meme/plugin-sdk/*': ['./.pi-meme-devkit/dist/node_modules/@pi-meme/plugin-sdk/src/*'],
            '@pi-meme/contracts/*': ['./.pi-meme-devkit/dist/node_modules/@pi-meme/contracts/src/*'],
            '@earendil-works/chord': ['./.pi-meme-devkit/dist/node_modules/@earendil-works/chord/dist/index.d.ts'],
            '@earendil-works/chord/*': ['./.pi-meme-devkit/dist/node_modules/@earendil-works/chord/dist/*'],
            react: ['./.pi-meme-devkit/dist/node_modules/@types/react/index.d.ts'],
            'react/*': ['./.pi-meme-devkit/dist/node_modules/@types/react/*'],
          },
        },
        include: ['src'],
      },
      null,
      2,
    )}\n`,
    '.gitignore': 'dist/\nnode_modules/\n*.pim\n',
    'README.md': `# ${displayName}\n\n源码入口和权限见 package.json 的 piMeme。构建工具和 SDK 在 .pi-meme-devkit，移动工程时一起保留。工具仅用于开发，不进入 .pim。工具产物位于 .pi-meme-devkit/dist，重新检出后可用系统 Plugin Creator 的 prepare 命令恢复，不重新初始化源码。\n\n在本目录执行：\n\n\`node .pi-meme-devkit/cli.mjs doctor\`\n\n\`npm run type-check\`\n\n\`npm run build\`\n\n\`npm run validate\`\n\n\`npm run pack\`\n\n命令不安装依赖，也不自动安装插件。把生成的 .pim 上传到设置「插件 → 添加」。可信 UI、Agent 和 Server 需要分别授权；Agent 插件还需在项目与会话中选择。\n`,
  }
  async function template(filename: string, values: Record<string, string> = {}) {
    const source = await readFile(path.join(tools, 'templates', filename), 'utf8')
    return source.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
      if (!(key in values)) throw new Error(`模板 ${filename} 缺少参数：${key}`)
      return values[key]
    })
  }
  files['.pi-meme-devkit/cli.mjs'] = await template('devkit.mjs.template')
  for (const kind of ['agent', 'server'] as const) {
    for (const runtime of ['restricted', 'trusted'] as const) {
      if (!manifest.piMeme[kind]?.[runtime]) continue
      const suffix = runtime === 'restricted' ? 'restricted' : 'entry'
      const contextType =
        runtime === 'restricted'
          ? kind === 'agent'
            ? 'RestrictedAgentContext'
            : 'RestrictedServerContext'
          : kind === 'agent'
            ? 'AgentPluginContext'
            : 'ServerPluginContext'
      files[`src/${kind}/${suffix}.ts`] = await template(`${kind}.ts.template`, {
        contextType,
        contextModule: runtime === 'restricted' ? 'restricted' : kind,
        toolName: name.replace(/[^a-z0-9]/g, '_'),
        timeExpression: manifest.piMeme.server?.[runtime]
          ? "await context.server.call<string>('time', {})"
          : 'new Date().toISOString()',
        audience: runtime === 'trusted' ? "['agent', 'ui']" : "['agent']",
      })
    }
  }
  if (ui !== 'none')
    files['src/ui/entry.tsx'] = await template(`ui-${ui}.tsx.template`, {
      displayName: JSON.stringify(displayName),
      displayNameExpression: `{${JSON.stringify(displayName)}}`,
    })
  if (resources.includes('skills'))
    files[`skills/${skillName}/SKILL.md`] = await template('skill.md.template', { skillName })
  if (resources.includes('themes')) files['themes/custom.json'] = await template('theme.json')
  if (resources.includes('assets'))
    files['assets/icon.svg'] =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="4" fill="#6c4eb3"/></svg>\n'
  await mkdir(path.dirname(path.resolve(directory)), { recursive: true })
  await mkdir(directory, { recursive: false })
  try {
    for (const [filename, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(directory, filename)), { recursive: true })
      await writeFile(path.join(directory, filename), content, { flag: 'wx' })
    }
    await preparePluginTools(directory)
  } catch (cause) {
    await rm(directory, { recursive: true, force: true })
    throw cause
  }
  return manifest
}
