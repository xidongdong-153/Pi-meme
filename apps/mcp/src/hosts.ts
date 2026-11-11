import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { createNodeHostClient, type NodeHostClient } from '@pi-meme/client/node-host-client'
import type { AppHostCapabilities, AppSession, ProjectRef, SessionRef, WorkspaceRef } from '@pi-meme/contracts/app-host'
import type { ScheduledTask, ScheduledTaskRef } from '@pi-meme/contracts/schedules'
import type { HostConfiguration, McpConfiguration } from './config'

export class McpError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export function publicSession(session: AppSession) {
  const { hostId, sessionId, project, cwd, createdAt, name, configuration, status, pinned } = session
  return { hostId, sessionId, project, cwd, createdAt, name, configuration, status, pinned }
}

export class HostContext {
  constructor(
    readonly configuration: HostConfiguration,
    readonly client: NodeHostClient,
    readonly capabilities: AppHostCapabilities,
  ) {}

  identity(ref: { hostId: string }) {
    if (ref.hostId !== this.capabilities.hostId) throw new McpError('host-mismatch', 'Ref 不属于所选 Host')
  }

  canAccessProject(ref?: ProjectRef) {
    if (!ref) return this.configuration.allowStandaloneSessions
    return (
      ref.hostId === this.capabilities.hostId &&
      (this.configuration.projectIds === undefined || this.configuration.projectIds.includes(ref.projectId))
    )
  }

  project(ref: ProjectRef) {
    this.identity(ref)
    if (!this.canAccessProject(ref)) throw new McpError('forbidden-project', '项目不在此 MCP 连接的授权范围内')
    return ref
  }

  standalone() {
    if (!this.configuration.allowStandaloneSessions)
      throw new McpError('forbidden-session', '此 MCP 连接不允许独立聊天')
  }

  async session(ref: SessionRef) {
    this.identity(ref)
    const session = await this.client.sessions.get(ref)
    if (session.temporary || !this.canAccessProject(session.project)) {
      throw new McpError('forbidden-session', '会话不在此 MCP 连接的授权范围内')
    }
    return session
  }

  async deletionTarget(ref: SessionRef | ScheduledTaskRef) {
    this.identity(ref)
    const missing = 'sessionId' in ref ? '会话不存在' : '定时任务不存在'
    try {
      if ('sessionId' in ref) await this.session(ref)
      else await this.task(ref)
    } catch (cause) {
      // 已删除对象无法再读取归属。仅让明确的不存在进入范围隔离的 Host 去重记录；
      // 没有该范围的已授权记录时 Host 仍拒绝，不能以“不存在”代替首次授权。
      if (
        !(cause instanceof Error) ||
        !('code' in cause) ||
        cause.code !== 'operation-failed' ||
        cause.message !== missing
      )
        throw cause
    }
  }

  async workspace(ref: WorkspaceRef) {
    if ('projectId' in ref) this.project(ref)
    else await this.session(ref)
    return ref
  }

  async task(ref: ScheduledTaskRef): Promise<ScheduledTask> {
    this.identity(ref)
    const task = await this.client.schedules.get(ref)
    if (!this.canAccessProject(task.project)) throw new McpError('forbidden-project', '定时任务不在授权范围内')
    return task
  }

  async receipt(operationId: string) {
    const receipt = await this.client.sessions.receipt(operationId)
    await this.session(receipt.session)
    return receipt
  }

  async agent(session: SessionRef, agentId: string) {
    await this.session(session)
    const agents = await this.client.agents.list(session)
    const agent = agents.find((item) => item.agentId === agentId)
    if (!agent) throw new McpError('forbidden-agent', 'Agent 不属于指定会话')
    return agent
  }
}

export class HostRegistry {
  private readonly clients = new Map<string, Promise<NodeHostClient>>()
  private readonly signals = new AsyncLocalStorage<AbortSignal>()
  private closed = false

  constructor(readonly configuration: McpConfiguration) {
    for (const host of configuration.hosts) {
      if (host.projectIds) Object.freeze(host.projectIds)
      Object.freeze(host)
    }
    Object.freeze(configuration.hosts)
    Object.freeze(configuration.allowedOrigins)
    Object.freeze(configuration)
  }

  private clientId(host: HostConfiguration) {
    const scope = [
      this.configuration.clientId,
      host.name,
      host.projectIds === undefined ? null : [...new Set(host.projectIds)].sort(),
      host.allowStandaloneSessions,
    ]
    // clientId + 幂等键是 Host 的去重域；收紧范围必须隔离此前已删除对象的操作记录。
    return `pi-meme-mcp:${createHash('sha256').update(JSON.stringify(scope)).digest('hex')}`
  }

  get hasWrites() {
    return this.configuration.hosts.some((host) => host.allowWrites)
  }

  get hasRegistration() {
    return this.configuration.hosts.some((host) => host.allowWrites && host.allowProjectRegistration)
  }

  list() {
    return this.configuration.hosts.map((host) => ({
      name: host.name,
      url: host.url,
      expectedHostId: host.hostId,
      allowWrites: host.allowWrites,
      allowProjectRegistration: host.allowProjectRegistration,
      projectIds: host.projectIds,
      allowStandaloneSessions: host.allowStandaloneSessions,
    }))
  }

  private host(name?: string) {
    if (this.closed) throw new McpError('closed', 'MCP 应用已关闭')
    if (name === undefined && this.configuration.hosts.length !== 1) {
      throw new McpError('host-required', '已配置多个 Host，请先调用 pi_meme_hosts 并指定 host 名称')
    }
    const host =
      name === undefined ? this.configuration.hosts[0] : this.configuration.hosts.find((item) => item.name === name)
    if (!host) throw new McpError('host-not-found', 'Host 名称未配置；不接受临时 URL')
    return host
  }

  async run<T>(
    name: string | undefined,
    write: boolean,
    signal: AbortSignal,
    operation: (context: HostContext) => Promise<T>,
  ): Promise<T> {
    const host = this.host(name)
    if (write && !host.allowWrites)
      throw new McpError('read-only', '所选 Host 为只读；由服务所有者在配置中开启 allowWrites')
    return this.signals.run(signal, async () => {
      if (signal.aborted) throw new McpError('cancelled', 'MCP 请求已取消；已经受理的 Host 操作须读取回执确认')
      let pending = this.clients.get(host.name)
      if (!pending) {
        pending = createNodeHostClient({
          url: host.url,
          token: host.token,
          hostId: host.hostId,
          clientId: this.clientId(host),
          fetch: (url, init) => {
            const activeSignal = this.signals.getStore()
            const signals = [AbortSignal.timeout(this.configuration.requestTimeoutMs)]
            if (init?.signal) signals.push(init.signal)
            if (activeSignal) signals.push(activeSignal)
            return fetch(url, { ...init, signal: AbortSignal.any(signals) })
          },
        })
        this.clients.set(host.name, pending)
        void pending.catch(() => {
          if (this.clients.get(host.name) === pending) this.clients.delete(host.name)
        })
      }
      const client = await pending
      if (this.closed) {
        client.dispose()
        throw new McpError('closed', 'MCP 应用已关闭')
      }
      const capabilities = await client.capabilities()
      if (capabilities.apiVersion !== 2) throw new McpError('unsupported-host', 'Host 必须支持 HostApi v2')
      return operation(new HostContext(host, client, capabilities))
    })
  }

  error(cause: unknown) {
    let code = 'upstream-error'
    let message = 'Host 操作失败'
    const networkCodes = new Set([
      'ECONNREFUSED',
      'ECONNRESET',
      'ENOTFOUND',
      'EAI_AGAIN',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'ETIMEDOUT',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_SOCKET',
    ])
    const tlsCodes = new Set([
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'ERR_TLS_CERT_ALTNAME_INVALID',
      'CERT_HAS_EXPIRED',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'SELF_SIGNED_CERT_IN_CHAIN',
    ])
    let diagnostic: string | undefined
    let current: unknown = cause
    for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
      if (
        'code' in current &&
        typeof current.code === 'string' &&
        (networkCodes.has(current.code) || tlsCodes.has(current.code))
      ) {
        diagnostic = current.code
        break
      }
      current = 'cause' in current ? current.cause : undefined
    }
    if (cause instanceof Error) {
      message = cause.message
      if ('code' in cause && typeof cause.code === 'string') code = cause.code
      if (message === 'fetch failed' || (diagnostic && networkCodes.has(diagnostic))) {
        code = 'host-unreachable'
        message = '无法连接 Host 服务；检查服务与网络后核对结果。写操作保留原幂等键，读取回执或用同键重试，不自动重放'
      }
      if (diagnostic && tlsCodes.has(diagnostic)) {
        code = 'host-tls-error'
        message = 'Host HTTPS 证书校验失败；核对域名、证书有效期与信任链，不关闭 TLS 校验'
      }
      if (cause.message === '服务登录失败') {
        code = 'host-auth-failed'
        message = 'Host 登录失败；由服务所有者检查上游令牌和认证设置'
      }
      if (cause.message === '服务身份已变化') {
        code = 'host-identity-changed'
        message = 'Host 身份与已确认目标不匹配；检查地址与数据目录，不自动接受新身份'
      }
      if (cause.name === 'TimeoutError' || cause.name === 'AbortError') {
        code = 'outcome-uncertain'
        message = '请求超时或已取消；不自动重放。保留原幂等键，读取回执或用同键核对操作结果'
      }
    }
    for (const secret of [this.configuration.token, ...this.configuration.hosts.map((host) => host.token)]) {
      if (secret) message = message.split(secret).join('[redacted]')
    }
    return { code, message: message.slice(0, 2000), ...(diagnostic ? { diagnostic } : {}) }
  }

  async dispose() {
    this.closed = true
    const clients = await Promise.allSettled(this.clients.values())
    for (const result of clients) if (result.status === 'fulfilled') result.value.dispose()
    this.clients.clear()
  }
}
