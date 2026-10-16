import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { LocalHostStatus } from '@pi-meme/contracts/host-runtime'
import { hostDataRoot } from './data-root'
import { assertLocalHostUrl, errorCode, readLocalHostStatus, waitForLocalHost } from './host-status'

async function verifyDataRoot(status: LocalHostStatus, dataRoot?: string) {
  const expected = await realpath(hostDataRoot(dataRoot)).catch((cause: unknown) => {
    if (errorCode(cause) === 'ENOENT') return hostDataRoot(dataRoot)
    throw cause
  })
  if (status.dataRoot !== expected)
    throw new Error('此端口的 Host 使用了不同数据目录，请统一 PI_MEME_DATA_ROOT 或指定其他 PI_MEME_PORT')
  const hostId = await readFile(path.join(expected, 'host-id'), 'utf8')
  if (hostId !== status.hostId) throw new Error('本机 Host 身份与数据目录不匹配，请停止管理方后重新启动')
}

export type LocalHostLease<T> =
  | { ownership: 'owned'; url: string; status: LocalHostStatus; resource: T }
  | { ownership: 'attached'; url: string; status: LocalHostStatus }

export async function acquireLocalHost<T extends { url: string; dispose: () => Promise<void> }>(options: {
  url: string
  dataRoot?: string
  create: () => Promise<T>
  allowReuse?: boolean
  timeoutMs?: number
}): Promise<LocalHostLease<T>> {
  const url = assertLocalHostUrl(options.url)
  const ephemeral = new URL(url).port === '0'
  const attach = async (status: LocalHostStatus): Promise<LocalHostLease<T>> => {
    await verifyDataRoot(status, options.dataRoot)
    if (options.allowReuse === false)
      throw new Error('已有 Host；新的令牌、TLS 或 Web 根目录参数不能应用到运行中的 Host，请先停止管理方')
    return { ownership: 'attached', url, status }
  }
  if (!ephemeral) {
    const existing = await readLocalHostStatus(url)
    if (existing) return attach(existing)
  }
  let resource: T
  try {
    resource = await options.create()
  } catch (cause) {
    if (ephemeral || !['ELOCKED', 'EADDRINUSE'].includes(errorCode(cause) ?? '')) throw cause
    return attach(await waitForLocalHost(url, { timeoutMs: options.timeoutMs }))
  }
  try {
    const status = await waitForLocalHost(resource.url, { timeoutMs: options.timeoutMs })
    await verifyDataRoot(status, options.dataRoot)
    return { ownership: 'owned', url: resource.url, status, resource }
  } catch (cause) {
    await resource.dispose()
    throw cause
  }
}
