import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parsePluginManifest } from '@pi-meme/plugin-sdk/manifest'

export async function createPlugin(directory: string, name: string) {
  const manifest = parsePluginManifest({
    name,
    version: '0.1.0',
    piMeme: {
      sdkVersion: 2,
      server: 'dist/server/chord-facets.json',
      agent: 'dist/agent/entry.js',
      ui: 'dist/ui/entry.js',
    },
  })
  await mkdir(directory, { recursive: false })
  for (const kind of ['server', 'agent', 'ui']) await mkdir(path.join(directory, 'src', kind), { recursive: true })
  const sdkDirectory = path.resolve(import.meta.dirname, '../../plugin-sdk')
  const sdkLink = `link:${path.relative(path.resolve(directory), sdkDirectory)}`
  const files: Record<string, string> = {
    'package.json': `${JSON.stringify(
      {
        ...manifest,
        type: 'module',
        peerDependencies: {
          '@pi-meme/plugin-sdk': '^0.1.0',
          react: '^19.3.0',
        },
        devDependencies: { '@pi-meme/plugin-sdk': sdkLink },
      },
      null,
      2,
    )}\n`,
    'src/server/entry.ts': `import type { ServerPluginContext } from '@pi-meme/plugin-sdk/server'

export function create(context: ServerPluginContext) {
  context.registerHandlers({
    [context.pluginId + ':time']: () => new Date().toISOString(),
    [context.pluginId + ':projects']: () => context.host.projects.list(),
  })
}
`,
    'src/agent/entry.ts': `import type { AgentPluginContext } from '@pi-meme/plugin-sdk/agent'

export function activate(context: AgentPluginContext) {
  context.tools.register({
    name: '${name.replace(/[^a-z0-9]/g, '_')}_time',
    title: '读取当前时间',
    description: '返回当前 UTC 时间。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute() {
      return { text: new Date().toISOString() }
    },
  })
  context.hooks.on('sessionStart', () => {
    context.interaction.setStatus('time', '时间工具已就绪')
  })
}
`,
    'src/ui/entry.tsx': `import { useState } from 'react'
import type { UiPluginContext } from '@pi-meme/plugin-sdk/ui'

function ClockPage({ readTime }: { readTime: () => Promise<string> }) {
  const [time, setTime] = useState('')
  const [error, setError] = useState('')
  return <section><h2>时间工具</h2><button onClick={() => {
    void readTime().then((value) => { setTime(value); setError('') }).catch((cause) => setError(String(cause)))
  }}>读取 Host 时间</button><p>{time}</p>{error && <p role="alert">{error}</p>}</section>
}

export function activate(context: UiPluginContext) {
  return context.panels.register({
    id: context.pluginId + ':clock',
    location: 'right',
    scope: 'app',
    icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>,
    title: '时间工具',
    render: () => <ClockPage readTime={() => context.call<string>(context.pluginId + ':time')} />,
  })
}
`,
    'README.md': `# ${name}

\`src/agent/entry.ts\` 注册 App 工具和生命周期事件；\`src/ui/entry.tsx\` 注册页面；\`src/server/entry.ts\` 注册 Host 操作。

SDK 开发依赖已链接到生成模板时使用的本地 SDK。移动开发目录后，重新配置 package.json 的 SDK link 路径。

先手动准备依赖（DevKit 不执行安装脚本）：

\`pnpm --dir ${directory} install --ignore-scripts\`

然后在 pi-meme 仓库根目录运行：

\`pnpm exec tsx packages/plugin-devkit/src/cli.ts build ${directory}\`

\`pnpm exec tsx packages/plugin-devkit/src/cli.ts validate ${directory}\`

\`pnpm exec tsx packages/plugin-devkit/src/cli.ts pack ${directory} ${directory}.pim\`

构建后，在插件页面加载目录或上传 .pim 包。插件使用宿主 React，不把 Node 产物放进浏览器。
`,
  }
  for (const [filename, contents] of Object.entries(files))
    await writeFile(path.join(directory, filename), contents, { flag: 'wx' })
  return manifest
}
