import type { ComponentType } from 'react'
import { Images, Upload, type LucideIcon } from 'lucide-react'
import type { ImageLibraryQuery } from '@pi-meme/contracts/image-library'
import { ImagePreviewStage } from '@pi-meme/chat/ui/content/image-viewer'
import type { ImageLibrarySource } from '../images/image-library-data'
import type { MaterialSummary, MaterialView } from './material-types'
import { summarizeImage } from './material-types'

export type MaterialCreateAction = { id: 'image.generate' | 'image.upload'; label: string; Icon: LucideIcon }
type MaterialPreviewProps = {
  material: MaterialSummary
  dataUrl: string
  index: number
  count: number
  onNavigate: (offset: number) => void
  onError?: (message: string) => void
}
type MaterialTypeDefinition = {
  kind: string
  label: string
  section: 'images'
  Icon: LucideIcon
  views: readonly MaterialView[]
  createActions: readonly MaterialCreateAction[]
  Preview: ComponentType<MaterialPreviewProps>
}

function ImageMaterialPreview({ material, dataUrl, index, count, onNavigate, onError }: MaterialPreviewProps) {
  return (
    <ImagePreviewStage
      image={{ type: 'image', mimeType: material.preview?.mimeType || 'image/png', data: dataUrl }}
      imageId={material.ref.id}
      index={index}
      count={count}
      onNavigate={onNavigate}
      onError={onError}
      autoFocus={false}
    />
  )
}

/** 只注册已实现的类型；侧栏、创建菜单和详情共用此定义。 */
export const materialRegistry: readonly MaterialTypeDefinition[] = [
  {
    kind: 'image',
    label: '图像',
    section: 'images',
    Icon: Images,
    views: ['masonry'],
    createActions: [
      { id: 'image.generate', label: '创建图像', Icon: Images },
      { id: 'image.upload', label: '上传图片', Icon: Upload },
    ],
    Preview: ImageMaterialPreview,
  },
]

/** 图片业务适配边界；后续类型接自己的业务 API，不把专属字段塞入共同摘要。 */
export const imageMaterialAdapter = {
  summarize: summarizeImage,
  list: (source: ImageLibrarySource, query: ImageLibraryQuery) => source.host.imageLibrary!.list(query),
  get: (source: ImageLibrarySource, id: string) => source.host.imageLibrary!.get(id),
  read: (source: ImageLibrarySource, id: string) => source.host.imageLibrary!.read(id),
  rename: (source: ImageLibrarySource, id: string, name: string) =>
    source.host.imageLibrary!.rename(id, name, { idempotencyKey: crypto.randomUUID() }),
  remove: (source: ImageLibrarySource, id: string) =>
    source.host.imageLibrary!.remove(id, { idempotencyKey: crypto.randomUUID() }),
}
