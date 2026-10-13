import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

const sharedModules = {
  react: 'shared-react',
  'react/jsx-runtime': 'shared-jsx-runtime',
  'react/jsx-dev-runtime': 'shared-jsx-dev-runtime',
  'react-dom': 'shared-react-dom',
  'react-dom/client': 'shared-react-dom-client',
}

export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
    {
      name: 'plugin-shared-react',
      transformIndexHtml: {
        order: 'pre',
        handler: (_html, context) => [
          {
            tag: 'script',
            attrs: { type: 'importmap' },
            injectTo: 'head-prepend',
            children: JSON.stringify({
              imports: Object.fromEntries(
                Object.entries(sharedModules).map(([name, entry]) => [
                  name,
                  context.server ? `/src/${entry}.ts` : `/assets/${entry}.js`,
                ]),
              ),
            }),
          },
        ],
      },
    },
  ],
  resolve: { preserveSymlinks: false, dedupe: ['react', 'react-dom'] },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: process.env.PI_MEME_HOST_URL ?? 'http://127.0.0.1:31415', ws: true, changeOrigin: false },
    },
  },
  build: {
    rollupOptions: {
      input: {
        app: fileURLToPath(new URL('./index.html', import.meta.url)),
        ...Object.fromEntries(
          Object.values(sharedModules).map((entry) => [
            entry,
            fileURLToPath(new URL(`./src/${entry}.ts`, import.meta.url)),
          ]),
        ),
      },
      preserveEntrySignatures: 'strict',
      output: { entryFileNames: 'assets/[name].js' },
    },
  },
})
