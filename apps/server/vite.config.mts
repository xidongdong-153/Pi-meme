import { defineConfig } from 'vite'
import { builtinModules } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { copyFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { copyBuiltinSkillsPlugin } from '../../scripts/copy-builtin-skills.mjs'

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

export default defineConfig({
  define: { __PI_MEME_VERSION__: JSON.stringify(version) },
  plugins: [
    copyBuiltinSkillsPlugin(),
    {
      name: 'copy-restricted-entry',
      async closeBundle() {
        const out = fileURLToPath(new URL('./dist', import.meta.url))
        await mkdir(out, { recursive: true })
        await copyFile(
          fileURLToPath(new URL('../../packages/plugin-runtime/src/restricted-entry.mjs', import.meta.url)),
          path.join(out, 'restricted-entry.mjs'),
        )
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
        'ssh-bootstrap': fileURLToPath(new URL('./src/ssh-bootstrap.ts', import.meta.url)),
        'session-worker': fileURLToPath(new URL('../../packages/host/src/session-worker.ts', import.meta.url)),
      },
      external: [
        ...builtinModules,
        ...builtinModules.map((value) => `node:${value}`),
        /^@earendil-works\/chord(?:\/|$)/,
        '@earendil-works/pi-coding-agent',
        '@napi-rs/keyring',
        'esbuild',
      ],
      output: { format: 'es', entryFileNames: '[name].js' },
    },
  },
})
