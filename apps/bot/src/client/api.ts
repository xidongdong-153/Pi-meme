import type { ApiError, Conversation, Snapshot } from '../shared/types'

export class RequestError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message)
  }
}
const pendingWrites = new Map<string, string>()
export async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; key?: string; signal?: AbortSignal } = {},
): Promise<T> {
  const method = options.method ?? 'GET'
  const form = options.body instanceof FormData
  const signature = `${method}:${path}:${form ? JSON.stringify(Array.from((options.body as FormData).entries()).map(([name, value]) => [name, typeof value === 'string' ? value : [value.name, value.size, value.lastModified]])) : JSON.stringify(options.body)}`
  const operationKey = options.key ?? pendingWrites.get(signature) ?? crypto.randomUUID()
  if (method !== 'GET') pendingWrites.set(signature, operationKey)
  const response = await fetch(path.startsWith('/api/') ? path : `/api/v1${path}`, {
    method,
    credentials: 'same-origin',
    signal: options.signal,
    headers: {
      ...(options.body && !form ? { 'Content-Type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'Idempotency-Key': operationKey } : {}),
    },
    body: options.body === undefined ? undefined : form ? (options.body as FormData) : JSON.stringify(options.body),
  })
  if (!response.ok) {
    if (response.status >= 400 && response.status < 500 && response.status !== 408) pendingWrites.delete(signature)
    const data = (await response.json().catch(() => null)) as ApiError | null
    throw new RequestError(
      data?.error?.code ?? 'request-failed',
      data?.error?.message ?? `请求失败 (${response.status})`,
      response.status,
    )
  }
  pendingWrites.delete(signature)
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}
export const getSnapshot = () => request<Snapshot>('/snapshot')
export function openBotConversation(botId: string) {
  return request<Conversation>(`/bots/${encodeURIComponent(botId)}/conversation`, { method: 'POST' })
}
export const attachmentUrl = (id: string) => `/api/v1/attachments/${encodeURIComponent(id)}/content`
