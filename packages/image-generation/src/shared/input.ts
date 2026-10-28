import type { ImageGenInput } from '@pi-meme/contracts/image-generation'

export function validateImageInput(value: ImageGenInput) {
  if (!value || typeof value.prompt !== 'string' || !value.prompt.trim()) throw new Error('图片提示词不能为空')
  if (value.referenced_image_paths != null && value.num_last_images_to_include != null)
    throw new Error('referenced_image_paths 与 num_last_images_to_include 不能同时提供')
  if (
    value.referenced_image_paths != null &&
    (!Array.isArray(value.referenced_image_paths) ||
      !value.referenced_image_paths.length ||
      value.referenced_image_paths.length > 5 ||
      value.referenced_image_paths.some((item) => typeof item !== 'string' || !item.trim()))
  )
    throw new Error('referenced_image_paths 必须包含 1～5 个图片路径')
  if (
    value.num_last_images_to_include != null &&
    (!Number.isInteger(value.num_last_images_to_include) ||
      value.num_last_images_to_include < 1 ||
      value.num_last_images_to_include > 5)
  )
    throw new Error('num_last_images_to_include 必须是 1～5 的整数')
  if (value.transparent_background != null && typeof value.transparent_background !== 'boolean')
    throw new Error('transparent_background 必须是布尔值')
}
