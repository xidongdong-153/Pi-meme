import type { PiImage } from './pi'
import type { SkillReference } from './skills'

export type TaskMode = 'default' | 'plan'
export type MessageOptions = { mode?: TaskMode }
export type QueuedInput = {
  id: string
  editing?: boolean
  submitted?: boolean
  text: string
  mode: TaskMode
  images?: PiImage[]
  skills?: SkillReference[]
}
export type PlanDocument = {
  id: string
  sessionId: string
  runId: string
  revision: number
  title: string
  markdown: string
  updatedAt: string
}
export type PlanEvent = { type: 'plan_saved'; document: PlanDocument }
export type SavePlanInput = { title: string; markdown: string }

export function isTaskMode(value: unknown): value is TaskMode {
  return value === 'default' || value === 'plan'
}

/** Host 和界面使用同一命令规则；纯命令只切换模式。 */
export function normalizePlanMessage(
  text: string,
  mode: TaskMode,
): { text: string; mode: TaskMode; commandOnly: boolean } {
  const match = text.match(/^\s*\/(?:plan|计划模式|计划)(?=$|\s)/)
  if (!match) return { text, mode, commandOnly: false }
  const body = text.slice(match[0].length).trimStart()
  return { text: body, mode: 'plan', commandOnly: !body.trim() }
}
