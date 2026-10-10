import type { PiSlashCommand } from '@pi-meme/contracts/pi'
import type { QueuedInput } from '@pi-meme/contracts/plan'
import { skillMarker, skillMessageParts } from '@pi-meme/contracts/skills'
import type { ComposerAttachment } from './image-attachment'

export function queuedDraft(input: QueuedInput, commands: PiSlashCommand[]) {
  const selectedSkills: PiSlashCommand[] = []
  let draft = skillMessageParts(input.text)
    .map((part) => {
      if (part.type === 'text') return part.text
      const skill = commands.find(
        (entry) =>
          entry.source === 'skill' && entry.name === `skill:${part.name}` && entry.sourceInfo.path === part.path,
      )
      if (!skill) return `$${part.name}`
      selectedSkills.push(skill)
      return skillMarker
    })
    .join('')
  for (const reference of input.skills ?? []) {
    if (selectedSkills.some((entry) => entry.name === `skill:${reference.name}`)) continue
    const skill = commands.find((entry) => entry.source === 'skill' && entry.name === `skill:${reference.name}`)
    if (skill) {
      selectedSkills.push(skill)
      draft += ` ${skillMarker}`
    } else draft += ` $${reference.name}`
  }
  const attachments: ComposerAttachment[] = (input.images ?? []).map((image) => ({ ...image, id: crypto.randomUUID() }))
  return { draft, selectedSkills, attachments, mode: input.mode }
}
