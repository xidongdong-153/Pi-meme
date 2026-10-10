import { defineConfig } from 'vite'
import { builtinModules } from 'node:module'
import { fileURLToPath } from 'node:url'

export default defineConfig({
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
        '@earendil-works/pi-coding-agent',
        '@napi-rs/keyring',
      ],
      output: { format: 'es', entryFileNames: '[name].js' },
    },
  },
})
