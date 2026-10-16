import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { hostRuntimeProtocolVersion, type LocalHostStatus } from '@pi-meme/contracts/host-runtime'

export function errorCode(cause: unknown): string | undefined {
  if (!cause || typeof cause !== 'object') return undefined
  if ('code' in cause && typeof cause.code === 'string') return cause.code
  return 'cause' in cause ? errorCode(cause.cause) : undefined
}

export function assertLocalHostUrl(value: string) {
  const url = new URL(value)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('共享本机 Host 必须使用不含路径和凭据的 loopback 地址')
  return url.origin
}

export async function readLocalHostStatus(url: string): Promise<LocalHostStatus | undefined> {
  const origin = assertLocalHostUrl(url)
  let response: Response
  try {
    response = await fetch(`${origin}/api/status`, { redirect: 'error', signal: AbortSignal.timeout(1000) })
  } catch (cause) {
    if (errorCode(cause) === 'ECONNREFUSED') return undefined
    throw new Error('本机端口没有返回有效的 Host 状态，请检查端口占用和监听地址', { cause })
  }
  const value: unknown = await response.json().catch(() => undefined)
  if (
    !response.ok ||
    !value ||
    typeof value !== 'object' ||
    !('product' in value) ||
    value.product !== 'pi-meme' ||
    !('runtimeProtocolVersion' in value) ||
    value.runtimeProtocolVersion !== hostRuntimeProtocolVersion ||
    !('hostId' in value) ||
    typeof value.hostId !== 'string' ||
    !value.hostId ||
    !('instanceId' in value) ||
    typeof value.instanceId !== 'string' ||
    !value.instanceId ||
    !('dataRoot' in value) ||
    typeof value.dataRoot !== 'string' ||
    !path.isAbsolute(value.dataRoot) ||
    !('owner' in value) ||
    (value.owner !== 'desktop' && value.owner !== 'server')
  )
    throw new Error('此端口不是兼容的 pi-meme Host，请停止占用程序或指定其他 PI_MEME_PORT')
  return value as LocalHostStatus
}

export async function waitForLocalHost(url: string, options: { hostId?: string; timeoutMs?: number } = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? 30000)
  do {
    const status = await readLocalHostStatus(url)
    if (status) {
      if (options.hostId && status.hostId !== options.hostId) throw new Error('本机 Host 身份已变化，请重新连接')
      return status
    }
    await delay(Math.min(100, Math.max(0, deadline - Date.now())))
  } while (Date.now() < deadline)
  throw new Error('Host 未启动或尚未就绪，请启动 Desktop 或 pnpm start:server')
}
