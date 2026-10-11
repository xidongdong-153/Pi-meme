import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

async function copySkillDirectory(source: string, target: string) {
  await mkdir(target, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const input = path.join(source, entry.name)
    const output = path.join(target, entry.name)
    if (entry.isDirectory()) await copySkillDirectory(input, output)
    else if (entry.isFile()) await writeFile(output, await readFile(input))
  }
}

export async function installBuiltinSkills(source: string, target: string) {
  const skill = path.join(source, 'skill-creator')
  try {
    await readFile(path.join(skill, 'SKILL.md'), 'utf8')
    await copySkillDirectory(skill, path.join(target, 'skill-creator'))
  } catch (cause) {
    throw new Error(`无法安装内置 Skill Creator：${skill}；${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    })
  }
}
