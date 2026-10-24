import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import {
  defaultDevelopmentFrontendPort,
  defaultDevelopmentHostPort,
  hostPort,
  localHostUrl,
} from '@pi-meme/contracts/host-runtime'
import { waitForLocalHost } from '@pi-meme/host/host-status'

const sharedModules = {
  react: 'shared-react',
  'react/jsx-runtime': 'shared-jsx-runtime',
  'react/jsx-dev-runtime': 'shared-jsx-dev-runtime',
  'react-dom': 'shared-react-dom',
  'react-dom/client': 'shared-react-dom-client',
}

export function createWebConfig(
  hostUrl = process.env.PI_MEME_HOST_URL ??
    localHostUrl(hostPort(process.env.PI_MEME_PORT, defaultDevelopmentHostPort)),
) {
  let hostId: string | undefined
  return defineConfig({
    plugins: [
      {
        name: 'local-host-readiness',
        config(_config, { command }) {
          if (command === 'serve') process.env.NODE_ENV = 'development'
        },
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (
              request.url?.split('?')[0] !== '/api/auth' ||
              !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(hostUrl).hostname)
            ) {
              next()
              return
            }
            void waitForLocalHost(hostUrl, { hostId })
              .then((status) => {
                hostId ??= status.hostId
                if (!response.destroyed) next()
              })
              .catch((cause: unknown) => {
                if (response.destroyed) return
                response.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
                response.end(
                  JSON.stringify({ error: cause instanceof Error ? cause.message : 'Host 未启动或尚未就绪' }),
                )
              })
          })
        },
      },
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
      port: defaultDevelopmentFrontendPort,
      strictPort: true,
      proxy: {
        '/api': { target: hostUrl, ws: true, changeOrigin: false },
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
}

export default createWebConfig()
