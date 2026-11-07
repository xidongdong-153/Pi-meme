import type { AppSession, SessionRef } from '@pi-meme/contracts/app-host'
import type { AuthorizationEffect, AuthorizationOperation } from '@pi-meme/contracts/authorization'
import type { TransportIdentity } from '@pi-meme/contracts/transport-identity'
import type { HostAuthorization } from './authorization'

export type TransportAuthorizationRequest = {
  requestId: string
  clientId?: string
  kind: 'rpc' | 'proxy' | 'resource' | 'subscription' | 'attachment'
  method: string
  args?: unknown[]
  session?: SessionRef
}
const specialReads = new Set([
  'host:ssh:capabilities',
  'host:ssh:list',
  'host:ssh:discover',
  'host:connections:list',
  'host:services:list',
])
const specialWrites = new Set([
  'host:ssh:save',
  'host:ssh:enabled',
  'host:ssh:retry',
  'host:ssh:remove',
  'host:connections:remove',
  'host:services:register',
  'host:services:retry',
  'host:services:remove',
])

function operation(request: TransportAuthorizationRequest): AuthorizationOperation {
  const resource = `transport:${request.kind}:${request.method}`
  let effects: AuthorizationEffect[]
  switch (request.kind) {
    case 'rpc':
      if (request.method === 'chat:file-preview') effects = [{ kind: 'fs.read', resource, boundary: 'workspace' }]
      else if (request.method === 'chat:link-preview') {
        if (typeof request.args?.[0] !== 'string') throw new Error('链接预览参数无效')
        const url = new URL(request.args[0])
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('链接协议不受支持')
        effects = [{ kind: 'network.read', resource: `${url.origin}${url.pathname}`, boundary: 'external' }]
      } else if (specialReads.has(request.method)) {
        effects = [
          { kind: request.method === 'host:ssh:discover' ? 'fs.read' : 'process.read', resource, boundary: 'host' },
        ]
      } else if (specialWrites.has(request.method)) {
        effects = [
          { kind: 'policy.write', resource, boundary: 'host' },
          { kind: 'process.write', resource, boundary: 'host' },
          { kind: 'network.write', resource, boundary: 'external' },
        ]
      } else throw new Error('permission-denied: 未声明的 transport RPC')
      break
    case 'resource':
      if (request.method !== 'plugin-resource') throw new Error('permission-denied: 未声明的 transport 资源')
      effects = [{ kind: 'fs.read', resource, boundary: 'host' }]
      break
    case 'subscription':
      if (!['events', 'control-events', 'remote-events'].includes(request.method))
        throw new Error('permission-denied: 未声明的事件订阅')
      effects = [
        {
          kind: request.method === 'remote-events' ? 'network.read' : 'process.read',
          resource,
          boundary: request.method === 'remote-events' ? 'external' : 'host',
        },
      ]
      break
    case 'attachment':
      if (request.method !== 'upload') throw new Error('permission-denied: 未声明的附件操作')
      effects = [{ kind: 'artifact.write', resource, boundary: 'host' }]
      break
    case 'proxy':
      // POST can execute arbitrary upstream RPC/control operations. Unknown verbs/routes never become reads.
      if (!['GET', 'POST'].includes(request.method)) throw new Error('permission-denied: 远程转发方法未声明')
      {
        const target = request.args?.[1]
        const read = request.method === 'GET' && typeof target === 'string' && target.startsWith('/api/plugins/')
        const write =
          request.method === 'POST' &&
          ['/api/auth', '/api/rpc', '/api/control', '/api/chat/attachments'].includes(String(target))
        if (!read && !write) throw new Error('permission-denied: 远程转发路由未声明')
        effects = [{ kind: read ? 'network.read' : 'network.write', resource, boundary: 'external' }]
      }
      break
    default:
      throw new Error('permission-denied: transport 操作未声明')
  }
  return {
    id: resource,
    effects,
    localReadOnly: request.kind === 'subscription' && request.method !== 'remote-events' ? true : undefined,
  }
}

/** Transport identity alone is not an effect lease. Every direct adapter executes inside this gate. */
export function createTransportAuthorizer(options: {
  authorization: HostAuthorization
  readSession: (ref: SessionRef, clientId: string) => AppSession
  genuine: (clientId: string, identity: TransportIdentity) => boolean
}) {
  return async function authorizeTransport<T>(
    request: TransportAuthorizationRequest,
    signal: AbortSignal | undefined,
    body: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    signal?.throwIfAborted()
    const identity = options.authorization.identity()
    if (!identity) throw new Error('permission-denied: transport 操作缺少认证身份')
    if (request.clientId && !options.genuine(request.clientId, identity))
      throw new Error('permission-denied: transport 客户端不是当前认证来源')
    const clientId = request.clientId ?? `transport:${identity.installationId}:${identity.connectionEpoch}`
    const context = await options.authorization.userContext(
      clientId,
      request.session ? () => options.readSession(request.session!, clientId) : undefined,
    )
    return options.authorization.execute(
      context,
      operation(request),
      request,
      `transport:${request.kind}:${request.requestId}`,
      body,
      signal,
    )
  }
}
