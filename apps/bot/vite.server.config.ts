import { defineConfig } from 'vite'
import { builtinModules } from 'node:module'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  build: {
    ssr: fileURLToPath(new URL('./src/server/main.ts', import.meta.url)),
    outDir: 'dist/server',
    emptyOutDir: true,
    rollupOptions: { external: [...builtinModules, ...builtinModules.map((name) => `node:${name}`)] },
  },
})
