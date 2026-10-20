import type { PiSlashCommand } from '@pi-meme/contracts/pi'
import type { QueuedInput } from '@pi-meme/contracts/plan'
import { skillMarker, skillMessageParts } from '@pi-meme/contracts/skills'
import type { ComposerAttachment } from './image-attachment'
import { messageAttachmentParts } from '../model/message-attachments'

export function queuedDraft(input: QueuedInput, commands: PiSlashCommand[]) {
  const selectedSkills: PiSlashCommand[] = []
  const references = input.skills ?? []
  let index = 0
  const restoreReference = () => {
    const reference = references[index++]
    if (!reference) return ''
    const skill = commands.find(
      (entry) =>
        entry.source === 'skill' && entry.resourceId === reference.id && entry.resourceRevision === reference.revision,
    )
    if (!skill) return `$${reference.name.replace(/^skill:/, '')}`
    selectedSkills.push(skill)
    return skillMarker
  }
  const parts = messageAttachmentParts(input.text)
  let draft = skillMessageParts(parts.text)
    .map((part) => {
      if (part.type === 'text') return part.text.replaceAll(skillMarker, restoreReference)
      const skill = commands.find(
        (entry) =>
          entry.source === 'skill' && entry.name === `skill:${part.name}` && entry.sourceInfo.path === part.path,
      )
      if (!skill) return `$${part.name}`
      selectedSkills.push(skill)
      return skillMarker
    })
    .join('')
  while (index < references.length) {
    const reference = references[index]!
    if (
      selectedSkills.some((entry) => entry.resourceId === reference.id && entry.resourceRevision === reference.revision)
    ) {
      index++
      continue
    }
    draft += ` ${restoreReference()}`
  }
  const attachments: ComposerAttachment[] = [
    ...(input.images ?? []).map((image) => ({ ...image, id: crypto.randomUUID() })),
    ...parts.attachments.map((file) => ({ ...file, id: crypto.randomUUID(), type: 'file' as const })),
  ]
  return { draft, selectedSkills, attachments, mode: input.mode }
}
