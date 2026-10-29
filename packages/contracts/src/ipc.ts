import { validateVisualizationContext } from './visualize'
import { isTaskMode, type MessageOptions, type EditMessageOptions } from './plan'
import type { SkillReference } from './skills'
import { thinkingLevels, type PiImage } from './pi'

export function text(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('参数必须是非空文本')
}
export function images(value: unknown): PiImage[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error('图片参数无效')
  for (const image of value) {
    if (
      !image ||
      image.type !== 'image' ||
      typeof image.data !== 'string' ||
      !image.data ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data) ||
      !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mimeType)
    )
      throw new Error('图片内容无效')
  }
  return value as PiImage[]
}
export function message(value: unknown, valueImages: unknown, valueSkills?: unknown) {
  if (typeof value !== 'string') throw new Error('消息参数无效')
  const parsedImages = images(valueImages)
  if (!value.trim() && !parsedImages?.length) throw new Error('消息不能为空')
  if (
    valueSkills !== undefined &&
    (!Array.isArray(valueSkills) ||
      valueSkills.some(
        (skill) =>
          !skill ||
          typeof skill.name !== 'string' ||
          !skill.name.startsWith('skill:') ||
          skill.name.length <= 6 ||
          typeof skill.id !== 'string' ||
          !skill.id ||
          typeof skill.revision !== 'string' ||
          !skill.revision,
      ))
  )
    throw new Error('技能参数无效')
  return { text: value, images: parsedImages, skills: (valueSkills ?? []) as SkillReference[] }
}

export function messageOptions(value: unknown): MessageOptions | undefined {
  if (value === undefined) return undefined
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) => !['mode', 'plan', 'visualization', 'clientProcessingAudit', 'model', 'thinkingLevel'].includes(key),
    )
  )
    throw new Error('消息模式参数无效')
  const { mode, plan, visualization, clientProcessingAudit, model, thinkingLevel } = value as MessageOptions
  if (visualization !== undefined) validateVisualizationContext(visualization)
  if (mode !== undefined && !isTaskMode(mode)) throw new Error('消息模式无效')
  if (plan !== undefined) {
    if (
      !plan ||
      typeof plan !== 'object' ||
      Array.isArray(plan) ||
      Object.keys(plan).some((key) => !['intent', 'reference'].includes(key)) ||
      !['execute', 'revise'].includes(plan.intent) ||
      !plan.reference ||
      typeof plan.reference !== 'object' ||
      Array.isArray(plan.reference) ||
      Object.keys(plan.reference).some((key) => !['id', 'revision'].includes(key)) ||
      typeof plan.reference.id !== 'string' ||
      !plan.reference.id.trim() ||
      !Number.isSafeInteger(plan.reference.revision) ||
      plan.reference.revision < 1 ||
      mode !== (plan.intent === 'execute' ? 'default' : 'plan')
    )
      throw new Error('计划引用或任务模式无效')
  }
  if (model !== undefined) {
    if (!model || typeof model !== 'object' || Array.isArray(model)) throw new Error('模型参数无效')
    text(model.provider)
    text(model.id)
  }
  if (thinkingLevel !== undefined && !thinkingLevels.includes(thinkingLevel)) throw new Error('思考强度无效')
  if (
    clientProcessingAudit !== undefined &&
    (!Array.isArray(clientProcessingAudit) ||
      clientProcessingAudit.length > 64 ||
      clientProcessingAudit.some(
        (entry) =>
          !entry ||
          typeof entry !== 'object' ||
          Array.isArray(entry) ||
          Object.keys(entry).some(
            (key) =>
              !['attemptId', 'pluginId', 'generation', 'hookId', 'outcome', 'reason', 'userConfirmedAt'].includes(key),
          ) ||
          ![entry.attemptId, entry.pluginId, entry.hookId].every((id) => typeof id === 'string' && id.length <= 256) ||
          !Number.isSafeInteger(entry.generation) ||
          !['pass', 'replace', 'block', 'error', 'timeout', 'skipped'].includes(entry.outcome) ||
          (entry.reason !== undefined && typeof entry.reason !== 'string') ||
          (entry.userConfirmedAt !== undefined &&
            (typeof entry.userConfirmedAt !== 'string' || !Number.isFinite(Date.parse(entry.userConfirmedAt)))),
      ))
  )
    throw new Error('客户端处理来源记录无效')
  return {
    mode,
    ...(plan ? { plan } : {}),
    ...(visualization ? { visualization: structuredClone(visualization) } : {}),
    ...(clientProcessingAudit === undefined ? {} : { clientProcessingAudit }),
    ...(model ? { model: { provider: model.provider, id: model.id } } : {}),
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
  }
}

export function editMessageOptions(value: unknown): EditMessageOptions | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('编辑配置无效')
  const { model, thinkingLevel, ...rest } = value as EditMessageOptions
  const parsed = messageOptions(rest)
  if (model !== undefined) {
    if (!model || typeof model !== 'object' || Array.isArray(model)) throw new Error('模型参数无效')
    text(model.provider)
    text(model.id)
  }
  if (thinkingLevel !== undefined && !thinkingLevels.includes(thinkingLevel)) throw new Error('思考强度无效')
  return {
    ...parsed,
    ...(model ? { model: { provider: model.provider, id: model.id } } : {}),
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
  }
}
