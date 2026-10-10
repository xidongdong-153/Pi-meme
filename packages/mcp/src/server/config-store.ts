import { mcpAuthorization } from '../shared/authorization'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { DeleteMcpServer, McpConfigSnapshot, SaveMcpServer } from '@pi-meme/contracts/mcp'
import type { SecureCredentialStorage } from '@pi-meme/contracts/secure-storage'
import { object, serverError } from '../shared/config'

export class McpConfigStore {
  private writing = false
  constructor(
    readonly filePath: string,
    private readonly credentials?: SecureCredentialStorage,
  ) {}
  private oauthSecretKey(name: string) {
    return `mcp-oauth-client:${name}`
  }
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
          throw new Error('配置必须是对象，mcpServers 必须是服务键值对象')
        data = parsed
      }
    } catch {
      error = 'MCP 配置文件损坏，请修复文件后重新加载；应用不会覆盖该文件'
    }
    return { revision, data, error }
  }
  async snapshot(): Promise<McpConfigSnapshot> {
    const { revision, data, error } = await this.read()
    const servers = object(data.mcpServers) ? data.mcpServers : {}
    return {
      path: this.filePath,
      revision,
      error,
      servers: Object.entries(servers).map(([name, config]) => {
        const clash = Object.keys(servers).some(
          (other) => other !== name && other.replace(/-/g, '_') === name.replace(/-/g, '_'),
        )
        const safeConfig = config && typeof config === 'object' ? structuredClone(config) : config
        if (object(safeConfig))
          safeConfig.desktopAuthorized =
            object(data.desktopAuthorizedServers) && data.desktopAuthorizedServers[name] === mcpAuthorization(config)
        if (object(safeConfig) && object(safeConfig.oauth)) {
          safeConfig.oauth.clientSecret = ''
        }
        return {
          name,
          config: safeConfig,
          error: serverError(name, config) ?? (clash ? '服务名称与其他服务的工具命名空间冲突' : undefined),
        }
      }),
    }
  }
  async save(input: SaveMcpServer) {
    const safeConfig = object(input.config) ? structuredClone(input.config) : input.config
    const config = object(safeConfig) ? safeConfig : undefined
    if (config) delete config.desktopAuthorized
    const oauth = config && object(config.oauth) ? config.oauth : undefined
    let oauthSecret: string | undefined
    if (oauth) {
      const supplied = oauth.clientSecret
      if (supplied !== undefined && typeof supplied !== 'string') throw new Error('OAuth Client Secret 必须是字符串')
      if (typeof supplied === 'string' && supplied) oauthSecret = supplied
      delete oauth.clientSecret
    }
    const oldName = input.previousName
    const oldSecret = oldName ? this.credentials?.get(this.oauthSecretKey(oldName)) : undefined
    const previousTargetSecret = this.credentials?.get(this.oauthSecretKey(input.name))
    const nextSecret = oauthSecret ?? (oauth ? oldSecret : undefined)
    if (nextSecret && !this.credentials) throw new Error('Desktop 安全存储未配置，无法保存 OAuth 凭据')
    try {
      if (nextSecret) this.credentials!.set(this.oauthSecretKey(input.name), nextSecret)
      const result = await this.change(input.revision, (servers) => {
        const error = serverError(input.name, input.config)
        if (error) throw new Error(error)
        if (input.previousName !== undefined && !Object.hasOwn(servers, input.previousName))
          throw new Error('原服务已不存在，请重新加载')
        if (input.name !== input.previousName && Object.hasOwn(servers, input.name)) throw new Error('服务名称已存在')
        for (const name of Object.keys(servers)) {
          if (
            name !== input.previousName &&
            name !== input.name &&
            name.replace(/-/g, '_') === input.name.replace(/-/g, '_')
          )
            throw new Error('服务名称与其他服务的工具命名空间冲突')
        }
        const next = { ...servers, [input.name]: safeConfig }
        if (input.previousName && input.previousName !== input.name) delete next[input.previousName]
        return next
      })
      if (oldName && oldName !== input.name) this.credentials?.delete(this.oauthSecretKey(oldName))
      if (!nextSecret) this.credentials?.delete(this.oauthSecretKey(input.name))
      return result
    } catch (cause) {
      if (previousTargetSecret === undefined) this.credentials?.delete(this.oauthSecretKey(input.name))
      else this.credentials?.set(this.oauthSecretKey(input.name), previousTargetSecret)
      throw cause
    }
  }
  delete(input: DeleteMcpServer) {
    return this.change(input.revision, (servers) => {
      if (!Object.hasOwn(servers, input.name)) throw new Error('服务已不存在，请重新加载')
      const next = { ...servers }
      delete next[input.name]
      return next
    }).then((snapshot) => {
      this.credentials?.delete(this.oauthSecretKey(input.name))
      return snapshot
    })
  }
  private async change(revision: string, modify: (servers: Record<string, unknown>) => Record<string, unknown>) {
    if (this.writing) throw new Error('MCP 配置正在保存，请等待完成')
    this.writing = true
    const temporary = `${this.filePath}.${randomUUID()}.tmp`
    try {
      const current = await this.read()
      if (current.error) throw new Error(current.error)
      if (revision !== current.revision) throw new Error('MCP 配置已被其他程序修改，请重新加载后再保存')
      const servers = object(current.data.mcpServers) ? current.data.mcpServers : {}
      const nextServers = modify(servers)
      for (const config of Object.values(nextServers)) {
        if (object(config) && object(config.oauth)) delete config.oauth.clientSecret
      }
      const previousAuthorizations = object(current.data.desktopAuthorizedServers)
        ? current.data.desktopAuthorizedServers
        : {}
      const authorizations = Object.fromEntries(
        Object.entries(previousAuthorizations).filter(([name]) => Object.hasOwn(nextServers, name)),
      )
      for (const [name, config] of Object.entries(nextServers)) {
        if (config !== servers[name] && object(config)) {
          if (config.enabled !== false) authorizations[name] = mcpAuthorization(config)
          else delete authorizations[name]
        }
      }
      const next = { ...current.data, mcpServers: nextServers, desktopAuthorizedServers: authorizations }
      await mkdir(path.dirname(this.filePath), { recursive: true })
      const mode = await stat(this.filePath).then(
        (info) => info.mode & 0o777,
        () => 0o600,
      )
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode, flag: 'wx' })
      if ((await this.read()).revision !== revision) throw new Error('MCP 配置已被其他程序修改，请重新加载后再保存')
      await rename(temporary, this.filePath)
      return await this.snapshot()
    } finally {
      await rm(temporary, { force: true })
      this.writing = false
    }
  }
}
