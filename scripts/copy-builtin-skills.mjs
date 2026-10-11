import { cp } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const skillSource = fileURLToPath(new URL('../pi/skills/skill-creator', import.meta.url))

export function copyBuiltinSkillsPlugin() {
  let outputDirectory = ''
  return {
    name: 'copy-builtin-skills',
    /** @param {{ root: string, build: { outDir: string } }} config */
    configResolved(config) {
      outputDirectory = path.resolve(config.root, config.build.outDir)
    },
    async closeBundle() {
      await cp(skillSource, path.join(outputDirectory, 'skills/skill-creator'), { recursive: true })
    },
  }
}
