import { skillMarker } from '@pi-meme/contracts/skills'
import type { PiSlashCommand } from '@pi-meme/contracts/pi'

/** 在草稿末尾追加一个技能标记。有提示语时跟在标记后面，供设置页唤起系统技能。 */
export function appendSkillInvocation(draft: string, prompt?: string) {
  const gap = draft && !/\s$/u.test(draft) ? ' ' : ''
  return `${draft}${gap}${skillMarker}${prompt ? ` ${prompt}` : ' '}`
}

export async function invokeSkillInNewSession(
  session: {
    newSession: () => Promise<boolean>
    setSelectedSkills: (skills: PiSlashCommand[]) => void
    setDraft: (draft: string) => void
    focusDraft: () => void
  },
  getCommands: () => Promise<PiSlashCommand[]>,
  name: string,
  prompt?: string,
) {
  if (!(await session.newSession())) throw new Error('新会话未能打开，请重试。')
  const commands = await getCommands()
  const command = commands.find((entry) => entry.source === 'skill' && entry.name === `skill:${name}`)
  if (!command) return false
  session.setSelectedSkills([command])
  session.setDraft(appendSkillInvocation('', prompt))
  session.focusDraft()
  return true
}
