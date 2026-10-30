import type { MutationOptions, ProjectRef, SessionRef } from './app-host'

export type ImageLibraryItem = {
  id: string
  hostId: string
  name: string
  prompt: string
  createdAt: string
  width: number
  height: number
  model: string
  operation: 'generate' | 'edit'
  sourceStatus?: 'detached'
  session: SessionRef
  project?: ProjectRef
  projectName?: string
}
export type ImageLibraryQuery = { projectId?: string; query?: string; cursor?: string; limit?: number }
export type ImageLibraryPage = {
  items: ImageLibraryItem[]
  nextCursor?: string
  projects: Array<{ id: string; name: string }>
  scan: { running: boolean; completed: number; total: number; skipped: number; error?: string }
}
export type ImageLibraryApi = {
  list: (input?: ImageLibraryQuery) => Promise<ImageLibraryPage>
  read: (id: string) => Promise<{ dataUrl: string; size: number }>
  rename: (id: string, name: string, options: MutationOptions) => Promise<void>
  remove: (id: string, options: MutationOptions) => Promise<void>
}
