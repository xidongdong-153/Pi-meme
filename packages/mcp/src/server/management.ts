import { randomUUID } from 'node:crypto'
import {
  completeMcpSignIn,
  listenForLoopbackSignIn,
  responseFromRedirectUrl,
  startMcpSignIn,
  waitForLoopbackSignIn,
  type McpSignInRedirect,
  type OAuthChallenge,
} from '@earendil-works/pi-mcp/oauth'
import type {
  AcquireMcpRefreshLock,
  McpCatalog,
  McpCheck,
  McpLogin,
  McpService,
  McpTarget,
} from '@pi-meme/contracts/mcp'
import type { SecureCredentialStorage } from '@pi-meme/contracts/secure-storage'
import type { PiRuntimePaths } from '@pi-meme/pi-runtime/runtime-paths'
import { createDesktopModelRuntime } from '@pi-meme/pi-runtime/sdk/model-runtime'
import { loadPiSdk } from '@pi-meme/pi-runtime/sdk/load'
import {
  DesktopMcpOAuthCredentials,
  loadDesktopMcpConfig,
  mcpToolsVisible,
  writeDesktopMcpWorkspaceOverride,
} from './runtime-config'
import { mcpAuthorization } from '../shared/authorization'
import { object } from '../shared/config'
import { authentication, oauthClient, probeMcpService } from './connection'
import type { McpConfigStore } from './config-store'

export type McpManagementContext = {
  paths: PiRuntimePaths
  credentials: SecureCredentialStorage & { flush?: () => Promise<void> }
  legacyDisabled: () => boolean
  cwd: (sessionKey: string) => string
  owner: () => string
  acquireMcpRefreshLock: AcquireMcpRefreshLock
  credentialChanged: (key: string, value?: string) => void
  configurationChanged: (cwd?: string) => void
}
type Attempt = {
  state: McpLogin
  owner: string
  identity: string
  controller: AbortController
  redirect?: McpSignInRedirect
  answer?: (value: string) => void
  task?: Promise<void>
}
export class McpManagement {
  private readonly oauth: DesktopMcpOAuthCredentials
  private readonly checks = new Map<string, { check: McpCheck; challenge?: OAuthChallenge }>()
  private readonly attempts = new Map<string, Attempt>()
  private readonly probes = new Map<string, Promise<McpCheck>>()
  constructor(
    private readonly context: McpManagementContext,
    private readonly store: McpConfigStore,
  ) {
    this.oauth = new DesktopMcpOAuthCredentials(
      context.credentials,
      context.credentialChanged,
      context.acquireMcpRefreshLock,
    )
  }
  private configuration(cwd?: string) {
    return loadDesktopMcpConfig(this.context.paths, cwd, this.context.credentials, this.context.legacyDisabled())
  }
  private cwd(key?: string) {
    if (key !== undefined && (typeof key !== 'string' || !key)) throw new Error('MCP 会话目标无效')
    const cwd = key ? this.context.cwd(key) : undefined
    return cwd
  }
  private resolve(input: unknown) {
    if (
      !object(input) ||
      typeof input.name !== 'string' ||
      typeof input.revision !== 'string' ||
      (input.sessionKey !== undefined && typeof input.sessionKey !== 'string')
    )
      throw new Error('MCP 服务目标无效')
    const cwd = this.cwd(input.sessionKey)
    const { servers } = this.configuration(cwd)
    const entry = servers.find((item) => item.name === input.name && item.revision === input.revision)
    if (!entry) throw new Error('服务配置已变化，请刷新后重试')
    return { entry, cwd, key: JSON.stringify(['url' in entry.config ? null : cwd, entry.name, entry.revision]) }
  }
  catalog(sessionKey?: string): McpCatalog {
    return this.catalogForDirectory(this.cwd(sessionKey), this.context.owner())
  }
  catalogForDirectory(cwd?: string, owner?: string): McpCatalog {
    const { servers, errors } = this.configuration(cwd)
    const services = servers.map(({ name, revision, config, scope, error, authorized }): McpService => {
      const http = 'url' in config
      const url = http && URL.canParse(config.url) ? new URL(config.url) : undefined
      const identity = JSON.stringify([name, http ? config.url : null])
      const login = [...this.attempts.values()].find(
        (item) => owner && item.owner === owner && item.identity === identity && this.pending(item),
      )
      return {
        name,
        revision,
        source: scope === 'global' ? 'global' : 'project',
        transport: http ? 'http' : 'stdio',
        endpoint: url ? `${url.origin}${url.pathname}` : http ? '' : config.command,
        description: config.description,
        enabled: config.enabled !== false,
        authorized,
        visible: mcpToolsVisible(config),
        authentication: authentication(config),
        provider: http ? config.auth?.provider : undefined,
        authenticationConfigured: http && Boolean(config.oauth || config.auth),
        headersConfigured: http && Object.keys(config.headers ?? {}).length > 0,
        environmentConfigured: !http && Object.keys(config.env ?? {}).length > 0,
        signedIn: http && !!this.oauth.tokens(name, config.url),
        error,
        loginId: login?.state.id,
        check: this.checks.get(JSON.stringify([http ? null : cwd, name, revision]))?.check,
      }
    })
    return { services, errors }
  }
  async setEnabled(target: McpTarget, enabled: boolean) {
    const { entry, cwd } = this.resolve(target)
    if (typeof enabled !== 'boolean' || entry.error) throw new Error(entry.error ?? '启用状态无效')
    if (cwd) {
      writeDesktopMcpWorkspaceOverride(this.context.paths, cwd, entry.name, { enabled }, mcpAuthorization(entry.config))
    } else {
      const snapshot = await this.store.snapshot()
      const current = snapshot.servers.find((s) => s.name === entry.name)
      if (!current || !object(current.config)) throw new Error('服务已移除，请刷新')
      this.resolve(target)
      await this.store.save({
        name: entry.name,
        previousName: entry.name,
        revision: snapshot.revision,
        config: { ...current.config, enabled },
      })
    }
    this.context.configurationChanged(cwd)
  }
  check(target: McpTarget) {
    const { entry, key, cwd } = this.resolve(target)
    if (entry.error || entry.config.enabled === false) throw new Error(entry.error ?? '请先启用此服务')
    let pending = this.probes.get(key)
    if (!pending) {
      pending = probeMcpService(
        entry.name,
        entry.config,
        cwd ?? this.context.paths.agentDir,
        this.oauth,
        async (id) => {
          const models = await createDesktopModelRuntime(
            await loadPiSdk(),
            this.context.paths.agentDir,
            this.context.credentials,
          )
          return (await models.getAuth(id))?.auth.apiKey
        },
      )
        .then(async (result) => {
          this.resolve(target)
          this.checks.set(key, result)
          await this.context.credentials.flush?.()
          return result.check
        })
        .finally(() => this.probes.delete(key))
      this.probes.set(key, pending)
    }
    return pending
  }
  private pending(attempt: Attempt) {
    return ['starting', 'waiting', 'checking'].includes(attempt.state.status)
  }
  private attempt(id: unknown) {
    const value = typeof id === 'string' && this.attempts.get(id)
    if (!value || value.owner !== this.context.owner()) throw new Error('登录操作已结束或不属于此客户端')
    return value
  }
  state(id: unknown) {
    return { ...this.attempt(id).state }
  }
  start(target: McpTarget) {
    const { entry, key } = this.resolve(target)
    const config = entry.config
    if (entry.error || config.enabled === false || !('url' in config) || authentication(config) !== 'auto')
      throw new Error('此服务当前无法使用 OAuth 登录')
    const identity = JSON.stringify([entry.name, config.url])
    const owner = this.context.owner()
    for (const [id, other] of this.attempts) {
      if (!this.pending(other)) {
        if (other.owner === owner) this.attempts.delete(id)
        continue
      }
      if (other.identity === identity) {
        if (other.owner === owner) return { ...other.state }
        throw new Error('另一个客户端正在登录此服务')
      }
    }
    const attempt: Attempt = {
      state: { id: randomUUID(), status: 'starting' },
      owner,
      identity,
      controller: new AbortController(),
    }
    this.attempts.set(attempt.state.id, attempt)
    const signal = attempt.controller.signal
    const timer = setTimeout(() => attempt.controller.abort(new Error('登录已超时，请重试')), 10 * 60_000)
    const run = async () => {
      const base = oauthClient(entry.name, config, this.oauth)
      const { callback, redirectUrl } = await listenForLoopbackSignIn(base)
      try {
        const options = { ...base, redirectUrl, signal, challenge: this.checks.get(key)?.challenge }
        const redirect = await startMcpSignIn(options)
        if (redirect.kind === 'redirect') {
          attempt.redirect = redirect
          attempt.state = { id: attempt.state.id, status: 'waiting', url: redirect.authorizationUrl }
          const response = await waitForLoopbackSignIn({
            callback,
            authorization: redirect,
            signal,
            promptForRedirectUrl: (promptSignal) =>
              new Promise((resolve) => {
                attempt.answer = resolve
                promptSignal.addEventListener('abort', () => resolve(undefined), { once: true })
              }),
          })
          signal.throwIfAborted()
          if (this.resolve(target).entry.config.enabled === false) throw new Error('服务已停用，请重新启用后登录')
          attempt.state = { id: attempt.state.id, status: 'checking' }
          await base.store.withRefreshLock(() => completeMcpSignIn({ ...options, authorization: redirect, response }))
        }
      } finally {
        attempt.answer = undefined
        attempt.redirect = undefined
        await callback.close()
      }
      await this.context.credentials.flush?.()
      this.context.configurationChanged()
      attempt.state = { id: attempt.state.id, status: 'checking' }
      await this.check(target)
      attempt.state = { id: attempt.state.id, status: 'done' }
    }
    attempt.task = run()
      .catch((cause) => {
        attempt.state = {
          id: attempt.state.id,
          status: signal.aborted && signal.reason?.name === 'AbortError' ? 'cancelled' : 'failed',
          error: signal.aborted
            ? signal.reason?.name === 'AbortError'
              ? undefined
              : signal.reason?.message
            : cause instanceof Error
              ? cause.message
              : '登录失败',
        }
      })
      .finally(() => clearTimeout(timer))
    return { ...attempt.state }
  }
  respond(id: unknown, value: unknown) {
    const attempt = this.attempt(id)
    if (!attempt.redirect || !attempt.answer || typeof value !== 'string' || value.length > 8192)
      throw new Error('当前未等待授权回调')
    try {
      responseFromRedirectUrl(value, attempt.redirect)
    } catch {
      throw new Error('回调地址无效或不属于本次登录，请复制当前授权页面返回的完整地址')
    }
    attempt.answer(value)
    attempt.answer = undefined
    return { ...attempt.state }
  }
  async cancel(id: unknown) {
    const attempt = this.attempt(id)
    attempt.controller.abort()
    await attempt.task
    return { ...attempt.state }
  }
  async logout(target: McpTarget) {
    const { entry, key: targetKey } = this.resolve(target)
    if (!('url' in entry.config) || authentication(entry.config) !== 'auto')
      throw new Error('此服务没有独立的 OAuth 账号')
    const identity = JSON.stringify([entry.name, entry.config.url])
    if ([...this.attempts.values()].some((item) => this.pending(item) && item.identity === identity))
      throw new Error('请先完成或取消正在进行的登录')
    await this.probes.get(targetKey)?.catch(() => {})
    this.resolve(target)
    const url = entry.config.url
    await this.oauth.forServer(entry.name, url).withRefreshLock(async () => {
      this.oauth.remove(entry.name, url)
      await this.context.credentials.flush?.()
    })
    this.context.configurationChanged()
    this.checks.delete(targetKey)
    if (entry.config.enabled !== false) await this.check(target)
  }
  async dispose() {
    for (const attempt of this.attempts.values()) attempt.controller.abort()
    await Promise.allSettled([...this.attempts.values()].map((attempt) => attempt.task))
    this.attempts.clear()
  }
}
