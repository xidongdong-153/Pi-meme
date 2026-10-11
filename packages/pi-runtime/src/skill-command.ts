import path from 'node:path'
import type { Skill } from '@earendil-works/pi-coding-agent'
import type { PiSlashCommand } from '@pi-meme/contracts/pi'

export function toSkillCommand(skill: Skill, agentDir: string): PiSlashCommand {
  const builtin =
    skill.name === 'skill-creator' &&
    path.resolve(skill.sourceInfo.path) === path.resolve(agentDir, 'builtin-skills', 'skill-creator', 'SKILL.md')
  return {
    name: `skill:${skill.name}`,
    description: skill.description,
    source: 'skill',
    sourceInfo: builtin ? { ...skill.sourceInfo, source: 'builtin', scope: 'user' } : skill.sourceInfo,
    ...(builtin ? { builtin: true, displayName: 'Skill Creator', shortDescription: '创建或更新技能' } : {}),
  }
}
