import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { randomBytes } from 'node:crypto'
import { createAdaptorServer } from '@hono/node-server'
import { WebSocketServer } from 'ws'
import { createHost, type HostOptions } from './service'
import { RemoteServices } from './remote-services'
import { createTransportAuth } from './transport-auth'
import { createTransportApp } from './transport-app'
import type { SshConnectionOptions } from './ssh-connections'

export type ServerOptions = HostOptions & {
  hostname?: string
  port?: number
  token?: string
  /** @deprecated 已忽略；本机连接同样需要令牌或私有配对票据。 */
  localAutoLogin?: boolean
  ssh?: SshConnectionOptions
  owner?: 'desktop' | 'server'
  staticDirectory?: string
  frontendUrl?: string
  tls?: { key: string | Buffer; cert: string | Buffer }
}

export async function startHostServer(options: ServerOptions = {}) {
  if (options.frontendUrl)
    throw new Error('runtime-snapshot-required: frontendUrl live 代理已移除，请配置不可变静态界面快照')
  if (options.token !== undefined && (!options.token.trim() || options.token.length > 4096))
    throw new Error('访问令牌不能为空且不能超过 4096 字符')
  const hostname = options.hostname ?? '127.0.0.1'
  const local = ['127.0.0.1', 'localhost', '::1'].includes(hostname)
  if (!local && !options.tls) throw new Error('远程服务必须配置 HTTPS 证书和私钥')
  const host = await createHost(options)
  const remotes = new RemoteServices(host.connections, host.root, options.ssh)
  try {
    await remotes.initialize()
  } catch (cause) {
    remotes.dispose()
    await remotes.flush().catch(() => {})
    await host.dispose()
    throw cause
  }
  const savedToken = host.credentials.get('host:token')
  const token = options.token ?? (savedToken?.trim() ? savedToken : randomBytes(32).toString('base64url'))
  if (host.credentials.get('host:token') !== token) {
    try {
      host.credentials.set('host:token', token)
      await host.flushCredentials()
    } catch (cause) {
      remotes.dispose()
      await remotes.flush().catch(() => {})
      await host.dispose()
      throw cause
    }
  }
  const auth = createTransportAuth({
    hostId: host.hostId,
    hostname,
    token,
    tls: Boolean(options.tls),
    localAutoLogin: options.localAutoLogin,
  })
  const sockets = new WebSocketServer({ noServer: true })
  const app = createTransportApp({ host, remotes, auth, options })
  const server = createAdaptorServer({
    fetch: app.fetch,
    overrideGlobalObjects: false,
    websocket: { server: sockets },
    ...(options.tls
      ? { createServer: createHttpsServer, serverOptions: options.tls }
      : { createServer: createHttpServer }),
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(options.port ?? 0, hostname, resolve)
    })
  } catch (cause) {
    remotes.dispose()
    await remotes.flush().catch(() => {})
    sockets.close()
    auth.dispose()
    await host.dispose()
    throw cause
  }
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('服务地址无效')
  const url = `${options.tls ? 'https' : 'http'}://${hostname.includes(':') ? `[${hostname}]` : hostname}:${address.port}`
  let disposing: Promise<void> | undefined
  return {
    host,
    remotes,
    url,
    createBootstrapTicket: auth.createBootstrapTicket,
    token,
    dispose() {
      disposing ??= (async () => {
        remotes.dispose()
        for (const connection of sockets.clients) connection.terminate()
        if ('closeAllConnections' in server) server.closeAllConnections()
        await new Promise<void>((resolve, reject) => server.close((cause) => (cause ? reject(cause) : resolve())))
        auth.dispose()
        try {
          await remotes.flush()
        } finally {
          await host.dispose()
        }
      })()
      return disposing
    },
  }
}
