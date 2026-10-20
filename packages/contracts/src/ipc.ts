import { isTaskMode, type MessageOptions } from './plan'
import type { SkillReference } from './skills'
import type { PiImage } from './pi'

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
    Object.keys(value).some((key) => key !== 'mode' && key !== 'clientProcessingAudit')
  )
    throw new Error('消息模式参数无效')
  const { mode, clientProcessingAudit } = value as MessageOptions
  if (mode !== undefined && !isTaskMode(mode)) throw new Error('消息模式无效')
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
  return { mode, ...(clientProcessingAudit === undefined ? {} : { clientProcessingAudit }) }
}
