import type {
  GeneratedImageLibraryItem,
  ImageLibraryItem,
  UploadedImageLibraryItem,
} from '@pi-meme/contracts/image-library'

export type LibraryRecord = ImageLibraryItem & { path: string; removed?: boolean }
export type LibraryState = {
  version: 2
  records: LibraryRecord[]
  scanned: Record<string, { revision: string; skipped: number }>
  imports: Record<string, { id: string; digest: string; name: string }>
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function decodeLibraryState(value: unknown, hostId: string): { state: LibraryState; legacy: boolean } {
  const invalid = () => {
    throw new Error('图像索引格式无效')
  }
  if (
    !object(value) ||
    (value.version !== 1 && value.version !== 2) ||
    !Array.isArray(value.records) ||
    !object(value.scanned)
  )
    return invalid()
  const legacy = value.version === 1
  const records = value.records.map((item: unknown): LibraryRecord => {
    if (
      !object(item) ||
      typeof item.id !== 'string' ||
      !item.id ||
      typeof item.path !== 'string' ||
      typeof item.name !== 'string' ||
      item.hostId !== hostId ||
      typeof item.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(item.createdAt)) ||
      typeof item.width !== 'number' ||
      !Number.isFinite(item.width) ||
      item.width <= 0 ||
      typeof item.height !== 'number' ||
      !Number.isFinite(item.height) ||
      item.height <= 0 ||
      (item.removed !== undefined && typeof item.removed !== 'boolean')
    )
      return invalid()
    const base = {
      id: item.id,
      hostId,
      path: item.path,
      name: item.name,
      createdAt: item.createdAt,
      width: item.width,
      height: item.height,
      ...(item.removed !== undefined ? { removed: item.removed } : {}),
    }
    if (!legacy && item.origin === 'uploaded') {
      if (
        !['image/png', 'image/jpeg', 'image/webp'].includes(String(item.mimeType)) ||
        ['session', 'project', 'projectName', 'model', 'operation', 'prompt', 'sourceStatus'].some(
          (key) => item[key] !== undefined,
        )
      )
        return invalid()
      return { ...base, origin: 'uploaded', mimeType: item.mimeType as UploadedImageLibraryItem['mimeType'] }
    }
    if (
      (legacy ? item.origin !== undefined && item.origin !== 'generated' : item.origin !== 'generated') ||
      (legacy ? item.mimeType !== undefined && item.mimeType !== 'image/png' : item.mimeType !== 'image/png') ||
      typeof item.prompt !== 'string' ||
      !object(item.session) ||
      typeof item.session.sessionId !== 'string' ||
      item.session.hostId !== hostId ||
      typeof item.model !== 'string' ||
      !['generate', 'edit'].includes(String(item.operation)) ||
      (item.sourceStatus !== undefined && item.sourceStatus !== 'detached') ||
      (item.project !== undefined &&
        (!object(item.project) || item.project.hostId !== hostId || typeof item.project.projectId !== 'string')) ||
      (item.projectName !== undefined && typeof item.projectName !== 'string')
    )
      return invalid()
    return {
      ...base,
      origin: 'generated',
      mimeType: 'image/png',
      prompt: item.prompt,
      session: { hostId, sessionId: item.session.sessionId },
      model: item.model,
      operation: item.operation as GeneratedImageLibraryItem['operation'],
      ...(item.sourceStatus === 'detached' ? { sourceStatus: 'detached' } : {}),
      ...(object(item.project) ? { project: { hostId, projectId: item.project.projectId as string } } : {}),
      ...(typeof item.projectName === 'string' ? { projectName: item.projectName } : {}),
    }
  })
  if (new Set(records.map((item) => item.id)).size !== records.length) return invalid()
  const scanned: LibraryState['scanned'] = Object.create(null)
  for (const [key, entry] of Object.entries(value.scanned)) {
    if (
      !object(entry) ||
      typeof entry.revision !== 'string' ||
      !Number.isInteger(entry.skipped) ||
      (entry.skipped as number) < 0
    )
      return invalid()
    scanned[key] = { revision: entry.revision, skipped: entry.skipped as number }
  }
  const imports: LibraryState['imports'] = Object.create(null)
  if (!legacy) {
    if (!object(value.imports)) return invalid()
    for (const [key, entry] of Object.entries(value.imports)) {
      if (
        !/^[a-f0-9]{64}$/.test(key) ||
        !object(entry) ||
        typeof entry.id !== 'string' ||
        !records.some((record) => record.id === entry.id && record.origin === 'uploaded') ||
        typeof entry.digest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(entry.digest) ||
        typeof entry.name !== 'string'
      )
        return invalid()
      imports[key] = { id: entry.id, digest: entry.digest, name: entry.name }
    }
  }
  return { state: { version: 2, records, scanned, imports }, legacy }
}

export function publicLibraryItem({ path: _path, removed: _removed, ...item }: LibraryRecord): ImageLibraryItem {
  return structuredClone(item)
}
