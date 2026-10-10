import { normalizePlanMessage, type TaskMode } from '@pi-meme/contracts/plan'
import { skillMarker } from '@pi-meme/contracts/skills'
import type { PiSlashCommand } from '@pi-meme/contracts/pi'

export function prepareComposerMessage(draft: string, mode: TaskMode) {
  const normalized = normalizePlanMessage(draft, mode)
  return {
    ...normalized,
    commandOnly:
      normalized.commandOnly || (normalized.text !== draft && !normalized.text.replaceAll(skillMarker, '').trim()),
  }
}
export function planCompletion(command: PiSlashCommand, draft: string, tokenStart: number, caret: number) {
  if (
    command.source !== 'builtin' ||
    !['plan', '计划', '计划模式'].includes(command.name) ||
    tokenStart !== draft.search(/\S/u)
  )
    return undefined
  return `/plan ${draft.slice(caret).trimStart()}`
}
export function sendQueueMode(
  running: boolean,
  queueMode: 'steering' | 'followUp',
  mode: TaskMode,
  activeMode?: TaskMode,
) {
  return running ? (activeMode && activeMode !== mode ? 'followUp' : queueMode) : 'prompt'
}
