import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { PiSlashCommand } from '@pi-meme/contracts/pi'
import { skillMarker, type SkillReference } from '@pi-meme/contracts/skills'

function escapeAttribute(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

export async function expandSkills(message: string, references: SkillReference[], commands: PiSlashCommand[]) {
  if ((message.match(/\uFFFC/g)?.length ?? 0) !== references.length)
    throw new Error('技能标记与选择数量不一致，请重新选择技能')
  const { stripFrontmatter } = await import('@earendil-works/pi-coding-agent')
  const blocks = await Promise.all(
    references.map(async ({ name }) => {
      const skill = commands.find((command) => command.source === 'skill' && command.name === name)
      if (!skill) throw new Error(`技能已不可用：${name.replace(/^skill:/, '')}，请重新选择`)
      const file = skill.sourceInfo.path
      let content: string
      try {
        content = await readFile(file, 'utf8')
      } catch (cause) {
        throw new Error(`读取技能失败：${file}`, { cause })
      }
      return `<skill name="${escapeAttribute(name.slice(6))}" location="${escapeAttribute(file)}">\nReferences are relative to ${skill.sourceInfo.baseDir ?? path.dirname(file)}.\n\n${stripFrontmatter(content).trim()}\n</skill>`
    }),
  )
  let index = 0
  return message.replaceAll(skillMarker, () => blocks[index++])
}
