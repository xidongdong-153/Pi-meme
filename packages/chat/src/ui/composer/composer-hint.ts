/** 占位只在空闲且草稿为空时出现。删空草稿会再显示；Esc 或发送才关掉。 */
export function visibleComposerHint(input: {
  hint?: string
  dismissed?: string
  draft: string
  skills: number
  attachments: number
  running: boolean
  paused: boolean
  queued: boolean
  editing: boolean
}) {
  if (!input.hint || input.hint === input.dismissed) return undefined
  if (input.running || input.paused || input.queued || input.editing) return undefined
  if (input.draft.trim() || input.skills > 0 || input.attachments > 0) return undefined
  return input.hint
}
