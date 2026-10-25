import { cp, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { toolchainDirectory } from '../packages/plugin-devkit/src/toolchain.ts'

const skillsRoot = fileURLToPath(new URL('../pi/skills', import.meta.url))

export async function preparePluginSkill(directory = skillsRoot) {
  const tools = await toolchainDirectory()
  const target = path.join(directory, 'plugin-creator/dist/toolchain')
  await rm(target, { recursive: true, force: true })
  await cp(tools, target, { recursive: true })
  let size = 0
  for (const entry of await readdir(path.join(directory, 'plugin-creator'), { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) size += (await stat(path.join(entry.parentPath, entry.name))).size
  }
  if (size > 32 * 1024 * 1024) throw new Error('Plugin Creator 超过技能快照的 32 MiB 上限')
}

export function copyBuiltinSkillsPlugin() {
  let outputDirectory = ''
  return {
    name: 'copy-builtin-skills',
    /** @param {{ root: string, build: { outDir: string } }} config */
    configResolved(config) {
      outputDirectory = path.resolve(config.root, config.build.outDir)
    },
    async closeBundle() {
      const entries = await readdir(skillsRoot, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        await cp(path.join(skillsRoot, entry.name), path.join(outputDirectory, 'skills', entry.name), {
          recursive: true,
          filter: (file) => file !== path.join(skillsRoot, 'plugin-creator/dist'),
        })
      }
      await preparePluginSkill(path.join(outputDirectory, 'skills'))
    },
  }
}
