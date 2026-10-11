import { defineConfig } from 'vite'
import { copyBuiltinSkillsPlugin } from '../../scripts/copy-builtin-skills.mjs'

export default defineConfig({
  plugins: [copyBuiltinSkillsPlugin()],
  build: { rollupOptions: { external: ['@earendil-works/pi-coding-agent', '@napi-rs/keyring'] } },
})
