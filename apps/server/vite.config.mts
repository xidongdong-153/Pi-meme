import { defineConfig } from 'vite'
import { builtinModules } from 'node:module'
import { fileURLToPath } from 'node:url'
import { copyFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { copyBuiltinSkillsPlugin } from '../../scripts/copy-builtin-skills.mjs'

export default defineConfig({
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
