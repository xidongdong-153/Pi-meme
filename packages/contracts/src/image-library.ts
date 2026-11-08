import type { MutationOptions, ProjectRef, SessionRef } from './app-host'

export type ImageLibraryMimeType = 'image/png' | 'image/jpeg' | 'image/webp'

type ImageLibraryBase = {
  id: string
  hostId: string
  name: string
  createdAt: string
  width: number
  height: number
}

export type GeneratedImageLibraryItem = ImageLibraryBase & {
  origin: 'generated'
  mimeType: 'image/png'
  prompt: string
  model: string
  operation: 'generate' | 'edit'
  sourceStatus?: 'detached'
  session: SessionRef
  project?: ProjectRef
  projectName?: string
}

export type UploadedImageLibraryItem = ImageLibraryBase & {
  origin: 'uploaded'
  mimeType: ImageLibraryMimeType
}

export type ImageLibraryItem = GeneratedImageLibraryItem | UploadedImageLibraryItem
export type ImageLibraryQuery = {
  /** Omitted for older clients: generated images only. */
  origin?: 'all' | 'generated' | 'uploaded'
  projectId?: string
  query?: string
  cursor?: string
  limit?: number
}
export type ImageLibraryPage = {
  items: ImageLibraryItem[]
  nextCursor?: string
  projects: Array<{ id: string; name: string }>
  scan: { running: boolean; completed: number; total: number; skipped: number; error?: string }
}
export type ImageLibraryUploadInput = {
  name: string
  data: Blob
  idempotencyKey: string
  signal?: AbortSignal
  onProgress?: (loaded: number, total: number) => void
}
export type ImageLibraryApi = {
  list: (input?: ImageLibraryQuery) => Promise<ImageLibraryPage>
  get: (id: string) => Promise<ImageLibraryItem>
  read: (id: string) => Promise<{ dataUrl: string; size: number }>
  /** Import an existing image inside this Host's attachment directory. */
  import: (input: { path: string; name?: string }, options: MutationOptions) => Promise<ImageLibraryItem>
  /** Browser clients inject the binary HTTP transport; never send Blob through JSON RPC. */
  upload?: (input: ImageLibraryUploadInput) => Promise<ImageLibraryItem>
  rename: (id: string, name: string, options: MutationOptions) => Promise<void>
  remove: (id: string, options: MutationOptions) => Promise<void>
}
