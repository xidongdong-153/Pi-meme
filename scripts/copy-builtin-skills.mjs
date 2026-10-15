import { cp, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const skillsRoot = fileURLToPath(new URL('../pi/skills', import.meta.url))

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
        })
      }
    },
  }
}
