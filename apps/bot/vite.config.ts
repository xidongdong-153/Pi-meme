import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [tailwindcss(), react()],
  resolve: { dedupe: ['react', 'react-dom'] },
  server: {
    host: '127.0.0.1',
    port: 4311,
    strictPort: true,
    proxy: { '/api': { target: process.env.BOTS_API_URL ?? 'http://127.0.0.1:4310', changeOrigin: false } },
  },
  build: { outDir: 'dist/web', emptyOutDir: true },
})
