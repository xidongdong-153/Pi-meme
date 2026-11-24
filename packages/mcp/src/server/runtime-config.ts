import { mcpAuthorization } from '../shared/authorization'
import type { McpReference, AcquireMcpRefreshLock } from '@pi-meme/contracts/mcp'
import { serverError } from '../shared/config'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type {
  InlineExtension,
  LoadedMcpConfig,
  McpExposure,
  McpServerConfig,
  McpServerEntry,
} from '@earendil-works/pi-coding-agent'
import type { McpOAuthState } from '@earendil-works/pi-mcp/oauth'
import type { SecureCredentialStorage } from '@pi-meme/contracts/secure-storage'
import type { PiRuntimePaths } from '@pi-meme/pi-runtime/runtime-paths'

type ConfigFile = { data?: Record<string, unknown>; error?: string }
type McpConfigPatch = { enabled?: boolean; exposure?: McpExposure }

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function readConfig(filePath: string): ConfigFile {
  let contents: string
  try {
    contents = readFileSync(filePath, 'utf8')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return {}
    return { error: `无法读取 MCP 配置 ${filePath}：${String(cause)}` }
  }
  try {
    const parsed: unknown = JSON.parse(contents)
    if (!isObject(parsed) || (parsed.mcpServers !== undefined && !isObject(parsed.mcpServers)))
      throw new Error('配置必须是对象，mcpServers 必须是服务键值对象')
    return { data: parsed }
  } catch (cause) {
    return { error: `MCP 配置无效 ${filePath}：${String(cause)}` }
  }
}

function completeServer(config: Record<string, unknown>) {
  return 'command' in config || 'url' in config || 'type' in config
}

function applyConfigFile(
  servers: Map<string, McpServerEntry>,
  filePath: string,
  scope: 'global' | 'project',
  errors: string[],
) {
  const loaded = readConfig(filePath)
  if (loaded.error) {
    errors.push(loaded.error)
    return loaded.data
  }
  const fileServers = loaded.data?.mcpServers
  if (isObject(fileServers)) {
    for (const [name, raw] of Object.entries(fileServers)) {
      if (!isObject(raw)) {
        errors.push(`${filePath} 中的 MCP 服务 ${name} 必须是对象`)
        continue
      }
      const previous = servers.get(name)
      if (completeServer(raw) || !previous) {
        servers.set(name, { name, config: raw as unknown as McpServerConfig, source: filePath, scope })
      } else {
        const config = { ...previous.config } as unknown as Record<string, unknown>
        for (const key of ['enabled', 'exposure', 'toolExposure']) if (key in raw) config[key] = raw[key]
        servers.set(name, {
          ...previous,
          config: config as unknown as McpServerConfig,
          scope: 'project',
          override: filePath,
        })
      }
    }
  }
  return loaded.data
}

export function loadDesktopMcpConfig(
  paths: PiRuntimePaths,
  cwd: string | undefined,
  credentials: SecureCredentialStorage,
  legacyDisabled = false,
) {
  const servers = new Map<string, McpServerEntry>()
  const errors: string[] = []
  const globalPath = path.join(paths.agentDir, 'mcp.json')
  const globalData = applyConfigFile(servers, globalPath, 'global', errors)
  const projectData = cwd ? applyConfigFile(servers, path.join(cwd, '.pi', 'mcp.json'), 'project', errors) : undefined
  const overrideData = cwd
    ? applyConfigFile(servers, path.join(paths.workspaceDirectory(cwd), 'mcp-overrides.json'), 'project', errors)
    : undefined
  const services = []
  const namespaces = new Set<string>()
  const collisions = new Set<string>()
  for (const name of servers.keys()) {
    const namespace = name.replaceAll('-', '_')
    if (namespaces.has(namespace)) collisions.add(namespace)
    namespaces.add(namespace)
  }
  for (const [name, entry] of servers) {
    const config = structuredClone(entry.config) as unknown as Record<string, unknown>
    const authorization = mcpAuthorization(config)
    const authorized =
      (!legacyDisabled && !(entry.source !== globalPath && config.auth)) ||
      [globalData, overrideData].some(
        (data) => isObject(data?.desktopAuthorizedServers) && data.desktopAuthorizedServers[name] === authorization,
      )
    if (!authorized) config.enabled = false
    const namespace = name.replaceAll('-', '_')
    const error =
      serverError(name, config) ?? (collisions.has(namespace) ? '服务名称与其他服务的工具命名空间冲突' : undefined)
    if (error) {
      errors.push(`${name}：${error}`)
      config.enabled = false
    }
    const revision = createHash('sha256')
      .update(
        JSON.stringify([
          entry.source,
          'command' in config ? cwd : null,
          authorization,
          config.exposure,
          config.toolExposure,
        ]),
      )
      .digest('hex')
    if (isObject(config.oauth)) {
      const oauth = { ...config.oauth }
      delete oauth.clientSecret
      const secret = entry.source === globalPath ? credentials.get(`mcp-oauth-client:${name}`) : undefined
      if (secret) oauth.clientSecret = secret
      config.oauth = oauth
    }
    services.push({ ...entry, config: config as unknown as McpServerConfig, revision, authorized, error })
  }

  const codemode = [globalData, projectData, overrideData]
    .reverse()
    .find((data) => isObject(data) && typeof data.autoEnableCodemode === 'boolean')
  return {
    servers: services,
    autoEnableCodemode: isObject(codemode) ? (codemode.autoEnableCodemode as boolean) : undefined,
    errors,
  }
}

export function createMcpRefreshLocks(): AcquireMcpRefreshLock {
  const tails = new Map<string, Promise<void>>()
  return async (key) => {
    const previous = tails.get(key) ?? Promise.resolve()
    const { promise, resolve } = Promise.withResolvers<void>()
    tails.set(key, promise)
    await previous
    return () => {
      resolve()
      if (tails.get(key) === promise) tails.delete(key)
    }
  }
}

export class DesktopMcpOAuthCredentials {
  constructor(
    private readonly storage: SecureCredentialStorage,
    private readonly changed?: (key: string, value?: string) => void,
    private readonly acquire: AcquireMcpRefreshLock = createMcpRefreshLocks(),
  ) {}

  private key(name: string, serverUrl: string) {
    const id = createHash('sha256').update(`${name}\0${serverUrl}`).digest('hex')
    return `mcp-oauth:${id}`
  }

  private state(key: string): McpOAuthState | undefined {
    const value = this.storage.get(key)
    if (!value) return undefined
    const parsed: unknown = JSON.parse(value)
    if (!isObject(parsed) || typeof parsed.serverUrl !== 'string') throw new Error('MCP OAuth 凭据格式无效')
    return parsed as unknown as McpOAuthState
  }

  forServer(name: string, serverUrl: string) {
    const key = this.key(name, serverUrl)
    return {
      load: () => this.state(key),
      save: (state: McpOAuthState) => {
        const value = JSON.stringify(state)
        this.storage.set(key, value)
        this.changed?.(key, value)
      },
      withRefreshLock: async <T>(fn: () => Promise<T>): Promise<T> => {
        const release = await this.acquire(key)
        try {
          return await fn()
        } finally {
          await release()
        }
      },
    }
  }

  tokens(name: string, serverUrl: string) {
    return this.state(this.key(name, serverUrl))?.tokens
  }

  remove(name: string, serverUrl: string) {
    const key = this.key(name, serverUrl)
    const removed = this.storage.delete(key)
    this.changed?.(key)
    return removed
  }
}

function writeWorkspaceOverride(filePath: string, name: string, patch: McpConfigPatch, authorization?: string) {
  let data: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
    if (!isObject(parsed) || (parsed.mcpServers !== undefined && !isObject(parsed.mcpServers)))
      throw new Error('覆盖配置无效')
    data = parsed
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Desktop MCP 工作区覆盖配置无效')
  }
  const servers = isObject(data.mcpServers) ? data.mcpServers : {}
  const previous = isObject(servers[name]) ? servers[name] : {}
  const authorizations = isObject(data.desktopAuthorizedServers) ? { ...data.desktopAuthorizedServers } : {}
  if (patch.enabled === true && authorization) authorizations[name] = authorization
  else if (patch.enabled === false) delete authorizations[name]
  const next = {
    ...data,
    mcpServers: { ...servers, [name]: { ...previous, ...patch } },
    desktopAuthorizedServers: authorizations,
  }
  const temporary = `${filePath}.${randomUUID()}.tmp`
  try {
    mkdirSync(path.dirname(filePath), { recursive: true })
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    renameSync(temporary, filePath)
  } finally {
    rmSync(temporary, { force: true })
  }
}

export function writeDesktopMcpWorkspaceOverride(
  paths: PiRuntimePaths,
  cwd: string,
  name: string,
  patch: McpConfigPatch,
  authorization?: string,
) {
  writeWorkspaceOverride(path.join(paths.workspaceDirectory(cwd), 'mcp-overrides.json'), name, patch, authorization)
}

export function mcpToolsVisible(config: McpServerConfig) {
  return config.exposure !== 'hidden' || Object.values(config.toolExposure ?? {}).some((mode) => mode !== 'hidden')
}

export function createDesktopMcpExtension(
  sdk: typeof import('@earendil-works/pi-coding-agent'),
  paths: PiRuntimePaths,
  credentials: SecureCredentialStorage,
  legacyDisabled = false,
  registerReferences?: (validate: (refs: McpReference[]) => void) => void,
  acquire?: AcquireMcpRefreshLock,
): InlineExtension {
  const options: NonNullable<Parameters<typeof sdk.createMcpExtension>[0]> = {
    loadConfig: (context): LoadedMcpConfig => {
      const loaded = loadDesktopMcpConfig(paths, context.cwd, credentials, legacyDisabled)
      registerReferences?.((refs) => {
        const current = loadDesktopMcpConfig(paths, context.cwd, credentials, legacyDisabled)
        for (const ref of refs) {
          const matches = (entry: (typeof loaded.servers)[number]) =>
            entry.name === ref.name &&
            entry.revision === ref.revision &&
            entry.config.enabled !== false &&
            mcpToolsVisible(entry.config)
          if (!loaded.servers.some(matches) || !current.servers.some(matches))
            throw new Error(`MCP 服务 ${ref.name} 已改变或不可用，请移除引用并重新选择`)
        }
      })
      return loaded
    },
    credentials: new DesktopMcpOAuthCredentials(credentials, undefined, acquire) as unknown as NonNullable<
      NonNullable<Parameters<typeof sdk.createMcpExtension>[0]>['credentials']
    >,
    logPath: path.join(paths.dataRoot, 'logs', 'mcp.log'),
  }
  return {
    name: 'pi-meme-mcp',
    factory: (pi) =>
      sdk.createMcpExtension(options)({
        ...pi,
        registerCommand: (name, command) => {
          if (name !== 'mcp') pi.registerCommand(name, command)
        },
      }),
  }
}
