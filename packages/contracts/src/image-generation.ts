import type { PiImage } from './pi'

export const imageGenerationCredentialPrefix = 'image-generation:'
export const imageSizes = ['auto', '1024x1024', '1536x1024', '1024x1536'] as const
export const imageQualities = ['auto', 'low', 'medium', 'high'] as const
export type ImageModelConfig = {
  id: string
  name: string
  baseUrl: string
  model: string
  size: (typeof imageSizes)[number]
  quality: (typeof imageQualities)[number]
  hasApiKey: boolean
}
export type ImageGenerationConfig = {
  revision: string
  models: ImageModelConfig[]
  defaultId?: string
  error?: string
}
export type SaveImageModel = {
  revision: string
  model: Omit<ImageModelConfig, 'hasApiKey'>
  apiKey?: string
  clearApiKey?: boolean
}
export type ImageGenInput = {
  prompt: string
  referenced_image_paths?: string[] | null
  num_last_images_to_include?: number | null
  transparent_background?: boolean | null
}
export type ImageSource = {
  entryId?: string
  index?: number
  path?: string
  image?: PiImage
}
export type ImageArtifact = {
  id: string
  path: string
  mimeType: 'image/png'
  operation: 'generate' | 'edit'
  model: string
  sources: Array<Omit<ImageSource, 'image'>>
}
export type ImageGenerationResult = { artifact: ImageArtifact; image: PiImage; retentionWarning?: string }
export type ImageGenerationRequest =
  { action: 'ready' } | { action: 'generate'; input: ImageGenInput; sources: ImageSource[] }
export type ImageGenerationReply = { ready: boolean } | ImageGenerationResult
export type ImageGenerationApi = {
  getConfig: () => Promise<ImageGenerationConfig>
  saveModel: (input: SaveImageModel) => Promise<ImageGenerationConfig>
  deleteModel: (id: string, revision: string) => Promise<ImageGenerationConfig>
  setDefault: (id: string, revision: string) => Promise<ImageGenerationConfig>
  test: (id: string) => Promise<ImageGenerationResult>
}
