import { defineConfig } from 'vite'
import { copyFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { copyBuiltinSkillsPlugin } from '../../scripts/copy-builtin-skills.mjs'

export default defineConfig(({ forgeConfigSelf }) => {
  let outputDirectory = ''
  return {
    // 多个入口共享输出目录，只由 Host 构建复制技能，避免并发创建同一目录。
    plugins:
      'entry' in forgeConfigSelf && forgeConfigSelf.entry === 'src/main/host-process.ts'
        ? [
            copyBuiltinSkillsPlugin(),
            {
              name: 'copy-restricted-entry',
              configResolved(config) {
                outputDirectory = path.resolve(config.root, config.build.outDir)
              },
              async closeBundle() {
                await copyFile(
                  fileURLToPath(new URL('../../packages/plugin-runtime/src/restricted-entry.mjs', import.meta.url)),
                  path.join(outputDirectory, 'restricted-entry.mjs'),
                )
              },
            },
          ]
        : [],
    build: {
      rollupOptions: {
        external: [/^@earendil-works\/chord(?:\/|$)/, '@earendil-works/pi-coding-agent', '@napi-rs/keyring', 'esbuild'],
      },
    },
  }
})
