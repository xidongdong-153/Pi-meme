import type { PlanDocument } from '@pi-meme/contracts/plan'

export function planExecutionDraft(draft: string, document: PlanDocument) {
  const instruction = `请按已保存的计划「${document.title}」（第 ${document.revision} 版）继续执行。\n\n${document.markdown}`
  return draft.trimEnd() ? `${draft.trimEnd()}\n\n${instruction}` : instruction
}
