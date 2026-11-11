import { builtinModules } from 'node:module'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import manifest from './package.json' with { type: 'json' }

export default defineConfig({
  plugins: [
    {
      name: 'standalone-mcp-manifest',
      async closeBundle() {
        const directory = fileURLToPath(new URL('./dist', import.meta.url))
        await mkdir(directory, { recursive: true })
        const runtime = {
          name: manifest.name,
          version: manifest.version,
          private: true,
          type: 'module',
          engines: manifest.engines,
          packageManager: 'pnpm@10.29.1',
          scripts: { start: 'node main.js', 'generate-plugin': 'node plugin-manifest.js' },
          dependencies: Object.fromEntries(
            Object.entries(manifest.dependencies).filter(([, version]) => !version.startsWith('workspace:')),
          ),
        }
        const readme =
          '# Pi meme MCP\n\n在本目录运行 `pnpm install --prod`，设置 `PI_MEME_HOST_URL`、`PI_MEME_HOST_TOKEN` 与独立 `PI_MEME_MCP_TOKEN`，再执行 `node main.js`。\n\n' +
          '默认 127.0.0.1:4311/mcp、只读。公开部署需 HTTPS 反向代理及 `PI_MEME_MCP_PUBLIC_URL`；直接非回环监听需证书与私钥。\n\n' +
          '多 Host 用 `node main.js --config /absolute/path/config.json`，可从 config.example.json 开始。stdio 用 `node main.js --transport stdio`。\n\n' +
          'Rakazo 连接器：`node plugin-manifest.js --url https://实际公网域名/mcp --out /new/output/directory`。不写凭据，不自动部署或发布。\n\n' +
          '完整权限、工具与部署说明：https://github.com/xidongdong-153/Pi-meme/tree/main/apps/mcp\n'
        await Promise.all([
          writeFile(path.join(directory, 'package.json'), `${JSON.stringify(runtime, null, 2)}\n`),
          writeFile(path.join(directory, 'README.md'), readme),
          copyFile(
            fileURLToPath(new URL('./config.example.json', import.meta.url)),
            path.join(directory, 'config.example.json'),
          ),
          copyFile(fileURLToPath(new URL('../../LICENSE', import.meta.url)), path.join(directory, 'LICENSE')),
        ])
      },
    },
  ],
  resolve: { conditions: ['node', 'import'] },
  ssr: { noExternal: [/^@pi-meme\//], resolve: { conditions: ['node', 'import'] } },
  build: {
    ssr: true,
    target: 'node22',
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./src/main.ts', import.meta.url)),
        'plugin-manifest': fileURLToPath(new URL('./src/plugin-manifest.ts', import.meta.url)),
      },
      external: [...builtinModules, ...builtinModules.map((value) => `node:${value}`)],
      output: { format: 'es', entryFileNames: '[name].js' },
    },
  },
})
