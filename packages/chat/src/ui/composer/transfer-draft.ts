import type { PiSlashCommand } from '@pi-meme/contracts/pi'
import { skillMarker } from '@pi-meme/contracts/skills'
import type { ComposerSnapshot } from '../use-chat-session'

export function transferDraft(composer: ComposerSnapshot, commands: PiSlashCommand[]) {
  const available = new Map(
    commands.filter((command) => command.source === 'skill').map((command) => [command.name, command]),
  )
  const selectedSkills: PiSlashCommand[] = []
  let index = 0
  let removedSkills = false
  const draft = composer.draft.replaceAll(skillMarker, () => {
    const skill = composer.selectedSkills[index++]
    if (!skill) return ''
    const next = available.get(skill.name)
    if (next) {
      selectedSkills.push(next)
      return skillMarker
    }
    removedSkills = true
    return `$${skill.name.replace(/^skill:/, '')}`
  })
  return {
    composer: { draft, selectedSkills, attachments: composer.attachments, queueMode: composer.queueMode },
    removedSkills,
  }
}
