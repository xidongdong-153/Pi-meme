import { mcpAuthorization } from '../shared/authorization'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import {
  mcpConfigCredentialPrefix,
  type DeleteMcpServer,
  type McpConfigSnapshot,
  type SaveMcpServer,
} from '@pi-meme/contracts/mcp'
import type { SecureCredentialStorage } from '@pi-meme/contracts/secure-storage'
import { object, serverError } from '../shared/config'
import { editableMcpConfig, loadGlobalMcpConfig, mcpConfigRef, restoreMcpConfig, sealMcpConfig } from './private-config'

function serversIn(data: Record<string, unknown>) {
  return object(data.mcpServers) ? data.mcpServers : {}
}

export class McpConfigStore {
  private writing = false
  constructor(
    readonly filePath: string,
    private readonly credentials: SecureCredentialStorage & { flush?: () => Promise<void> },
    private readonly providerAllowsOrigin: (provider: string, origin: string) => Promise<boolean>,
  ) {}

  private async read() {
    let content: string | undefined
    try {
      content = await readFile(this.filePath, 'utf8')
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取 MCP 配置，请检查文件权限')
    }
    const revision = createHash('sha256')
      .update(content === undefined ? 'missing' : `file:${content}`)
      .digest('hex')
    let data: Record<string, unknown> = {}
    let error: string | undefined
    try {
      if (content !== undefined) {
        const parsed: unknown = JSON.parse(content)
        if (!object(parsed) || (parsed.mcpServers !== undefined && !object(parsed.mcpServers)))
          throw new Error('MCP 配置必须是对象，mcpServers 必须是服务键值对象')
        data = parsed
      }
    } catch {
      error = 'MCP 配置文件损坏，请修复文件后重新加载；应用不会覆盖该文件'
    }
    return { revision, data, error }
  }

  async snapshot(): Promise<McpConfigSnapshot> {
    const { revision, data, error } = await this.read()
    const servers = serversIn(data)
    return {
      path: this.filePath,
      revision,
      error,
      servers: Object.entries(servers).map(([name, config]) => {
        try {
          if (!object(config)) return { name, config: null, error: '服务配置必须是 JSON 对象' }
          const resolved = loadGlobalMcpConfig(name, config, this.credentials)
          const clash = Object.keys(servers).some(
            (other) => other !== name && other.replace(/-/g, '_') === name.replace(/-/g, '_'),
          )
          return {
            name,
            config: {
              ...editableMcpConfig(resolved),
              desktopAuthorized:
                object(data.desktopAuthorizedServers) &&
                data.desktopAuthorizedServers[name] === mcpAuthorization(resolved),
            },
            error: serverError(name, resolved) ?? (clash ? '服务名称与其他服务的工具命名空间冲突' : undefined),
          }
        } catch {
          return { name, config: null, error: 'MCP 连接配置不可用' }
        }
      }),
    }
  }

  /** Run with the Host data directory locked, before loading sessions or publishing the HTTP API. */
  async migratePrivateConfig() {
    const { revision, data, error } = await this.read()
    if (error) return
    const servers = serversIn(data)
    const legacy = Object.entries(servers).filter(([, config]) => object(config) && !mcpConfigRef(config))
    if (!legacy.length) return
    const next = { ...servers }
    for (const [name, config] of legacy) {
      const resolved = loadGlobalMcpConfig(name, config as Record<string, unknown>, this.credentials)
      next[name] = sealMcpConfig(name, resolved, this.credentials)
    }
    await this.publish(revision, { ...data, mcpServers: next })
  }

  async assertProviderOrigin(provider: string, url: string) {
    if (!(await this.providerAllowsOrigin(provider, new URL(url).origin)))
      throw new Error('MCP 服务地址必须与所用模型凭据的服务商同源')
  }

  async save(input: SaveMcpServer, agent = false) {
    if (
      !input ||
      typeof input.name !== 'string' ||
      (input.previousName !== undefined && typeof input.previousName !== 'string')
    )
      throw new Error('MCP 服务目标无效')
    return this.change(input.revision, async (servers, authorizations) => {
      const { name, previousName } = input
      if (previousName !== undefined && !Object.hasOwn(servers, previousName))
        throw new Error('原服务已不存在，请重新加载')
      if (name !== previousName && Object.hasOwn(servers, name)) throw new Error('服务名称已存在')
      if (
        Object.keys(servers).some(
          (other) => other !== previousName && other.replace(/-/g, '_') === name.replace(/-/g, '_'),
        )
      )
        throw new Error('服务名称与其他服务的工具命名空间冲突')
      const previousStorage = previousName === undefined ? undefined : servers[previousName]
      const previous =
        previousName && object(previousStorage)
          ? loadGlobalMcpConfig(previousName, previousStorage, this.credentials)
          : undefined
      if (!object(input.config)) throw new Error('服务配置必须是 JSON 对象')
      const config = restoreMcpConfig(input.config, previous)
      const error = serverError(name, config)
      if (error) throw new Error(error)
      if (object(config.auth)) {
        const provider = config.auth.provider as string
        const origin = new URL(config.url as string).origin
        const existingGrant =
          object(previous?.auth) &&
          previous.auth.provider === provider &&
          typeof previous.url === 'string' &&
          new URL(previous.url).origin === origin
        if (agent && !existingGrant) throw new Error('Agent 只能使用已绑定到该服务地址的模型凭据')
        if (!existingGrant) await this.assertProviderOrigin(provider, config.url as string)
      }
      if (
        agent &&
        previous &&
        mcpAuthorization(previous) !== mcpAuthorization(config) &&
        ['auth', 'headers', 'env', 'args', 'oauth'].some((key) => Object.hasOwn(previous, key))
      )
        throw new Error('Agent 无法更改使用已保存凭据的 MCP 连接')
      const stored = sealMcpConfig(name, config, this.credentials)
      if (previousName && previousName !== name) {
        delete servers[previousName]
        delete authorizations[previousName]
      }
      Object.defineProperty(servers, name, { value: stored, enumerable: true, configurable: true, writable: true })
      if (config.enabled !== false)
        Object.defineProperty(authorizations, name, {
          value: mcpAuthorization(config),
          enumerable: true,
          configurable: true,
          writable: true,
        })
      else delete authorizations[name]
      return mcpConfigRef(previousStorage)
    })
  }

  delete(input: DeleteMcpServer) {
    return this.change(input.revision, (servers, authorizations) => {
      if (!Object.hasOwn(servers, input.name)) throw new Error('服务已不存在，请重新加载')
      const ref = mcpConfigRef(servers[input.name])
      delete servers[input.name]
      delete authorizations[input.name]
      return ref
    })
  }

  private async change(
    revision: string,
    modify: (
      servers: Record<string, unknown>,
      authorizations: Record<string, unknown>,
    ) => string | undefined | Promise<string | undefined>,
  ) {
    if (this.writing) throw new Error('MCP 配置正在保存，请等待完成')
    this.writing = true
    try {
      const current = await this.read()
      if (current.error) throw new Error(current.error)
      if (revision !== current.revision) throw new Error('MCP 配置已被其他程序修改，请重新加载后再保存')
      const servers = { ...serversIn(current.data) }
      const previous = current.data.desktopAuthorizedServers
      const authorizations = object(previous) ? { ...previous } : {}
      const removedRef = await modify(servers, authorizations)
      await this.publish(revision, { ...current.data, mcpServers: servers, desktopAuthorizedServers: authorizations })
      if (removedRef?.startsWith(mcpConfigCredentialPrefix)) {
        this.credentials.delete(removedRef)
        await this.credentials.flush?.()
      }
      return await this.snapshot()
    } finally {
      this.writing = false
    }
  }

  private async publish(revision: string, next: Record<string, unknown>) {
    const temporary = `${this.filePath}.${randomUUID()}.tmp`
    await mkdir(path.dirname(this.filePath), { recursive: true })
    const handle = await open(temporary, 'wx', 0o600)
    try {
      try {
        await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await this.credentials.flush?.()
      if ((await this.read()).revision !== revision) throw new Error('MCP 配置已被其他程序修改，请重新加载后再保存')
      await rename(temporary, this.filePath)
    } finally {
      await rm(temporary, { force: true })
    }
  }
}
