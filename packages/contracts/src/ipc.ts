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
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => key !== 'mode'))
    throw new Error('消息模式参数无效')
  const mode = (value as MessageOptions).mode
  if (mode !== undefined && !isTaskMode(mode)) throw new Error('消息模式无效')
  return { mode }
}
