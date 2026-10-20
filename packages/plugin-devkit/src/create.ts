import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parsePluginManifest } from '@pi-meme/plugin-sdk/manifest'

export async function createPlugin(directory: string, name: string) {
  const manifest = parsePluginManifest({
    name,
    version: '0.1.0',
    piMeme: {
      sdkVersion: 3,
      server: { restricted: 'dist/server/restricted.js' },
      agent: { restricted: 'dist/agent/restricted.js' },
      ui: 'dist/ui/entry.js',
      permissions: { restricted: { maxAccess: 'read-only', capabilities: [] }, ui: [] },
    },
  })
  await mkdir(directory, { recursive: false })
  for (const kind of ['server', 'agent', 'ui']) await mkdir(path.join(directory, 'src', kind), { recursive: true })
  const sdkDirectory = path.resolve(import.meta.dirname, '../../plugin-sdk')
  const files: Record<string, string> = {
    'package.json': `${JSON.stringify({ ...manifest, type: 'module', peerDependencies: { '@pi-meme/plugin-sdk': '^0.1.0', react: '^19.3.0' }, devDependencies: { '@pi-meme/plugin-sdk': `link:${path.relative(path.resolve(directory), sdkDirectory)}` } }, null, 2)}\n`,
    'src/server/restricted.ts': `import type { RestrictedServerContext } from '@pi-meme/plugin-sdk/restricted'
export function create(context: RestrictedServerContext) {
  context.registerOperations([{
    name: 'time', inputSchema: {type:'object', additionalProperties:false}, outputSchema: {type:'string'},
    audience: ['agent'], effect: 'read', capabilities: [],
    execute: () => new Date().toISOString(),
  }])
}
`,
    'src/agent/restricted.ts': `import type { RestrictedAgentContext } from '@pi-meme/plugin-sdk/restricted'
export function activate(context: RestrictedAgentContext) {
  context.tools.register({
    name: '${name.replace(/[^a-z0-9]/g, '_')}_time', title: '读取当前时间', description: '返回当前 UTC 时间。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    effect: 'read', capabilities: [],
    execute: async () => ({text: await context.server.call<string>('time', {})}),
  })
}
`,
    'src/ui/entry.tsx': `import type { UiPluginContext } from '@pi-meme/plugin-sdk/ui'
export function activate(context: UiPluginContext) {
  return context.panels.register({id: context.pluginId + ':overview',title:'时间工具',icon:'T',location:'right',scope:'app',render:()=> <section><h2>时间工具</h2><p>在聊天中选择此插件后，可使用受限时间工具。界面需单独信任授权。</p></section>})
}
`,
    'README.md': `# ${name}\n\nSDK 3 受限 Agent 与 Server 独立构建，不取得完整 HostApi。UI 是可信同源代码，加载前需单独授权。\n\nSDK link 指向创建时的本地仓库，移动目录后需修正。DevKit 不安装依赖、不执行安装脚本。\n\n在 pi-meme 仓库执行：\n\n\`pnpm exec tsx packages/plugin-devkit/src/cli.ts build ${directory}\`\n\n\`pnpm exec tsx packages/plugin-devkit/src/cli.ts validate ${directory}\`\n\n\`pnpm exec tsx packages/plugin-devkit/src/cli.ts pack ${directory} ${directory}.pim\`\n\n构建与打包不会自动安装，需在设置上传 .pim。\n`,
  }
  for (const [filename, content] of Object.entries(files))
    await writeFile(path.join(directory, filename), content, { flag: 'wx' })
  return manifest
}
