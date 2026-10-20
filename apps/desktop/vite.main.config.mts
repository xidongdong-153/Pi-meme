import { defineConfig } from 'vite'
import { copyBuiltinSkillsPlugin } from '../../scripts/copy-builtin-skills.mjs'

export default defineConfig(({ forgeConfigSelf }) => ({
  // 多个入口共享输出目录，只由 Host 构建复制技能，避免并发创建同一目录。
  plugins:
    'entry' in forgeConfigSelf && forgeConfigSelf.entry === 'src/main/host-process.ts'
      ? [copyBuiltinSkillsPlugin()]
      : [],
  build: {
    rollupOptions: {
      external: [/^@earendil-works\/chord(?:\/|$)/, '@earendil-works/pi-coding-agent', '@napi-rs/keyring', 'esbuild'],
    },
  },
}))
