import { mcpAuthorization } from '../shared/authorization'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type {
  InlineExtension,
  LoadedMcpConfig,
  McpExposure,
  McpServerConfig,
  McpServerEntry,
  ExtensionAPI,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import type { McpOAuthState } from '@earendil-works/pi-mcp/oauth'
import type { SecureCredentialStorage } from '@pi-meme/contracts/secure-storage'
import type { PiRuntimePaths } from '@pi-meme/pi-runtime/runtime-paths'
import type { AccessSandboxOperations } from '@pi-meme/pi-runtime/sdk/access-sandbox'
import type { PlanToolSource } from '@pi-meme/contracts/plan'
import { createPlanTransport } from './plan-transport'

type PlanMcpOptions = {
  active: () => boolean
  sandbox: () => AccessSandboxOperations
  register: (name: string, source: PlanToolSource) => void
}

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
  cwd: string,
  credentials: SecureCredentialStorage,
  legacyDisabled = false,
): LoadedMcpConfig {
  const servers = new Map<string, McpServerEntry>()
  const errors: string[] = []
  const globalPath = path.join(paths.agentDir, 'mcp.json')
  const projectPath = path.join(cwd, '.pi', 'mcp.json')
  const overridePath = path.join(paths.workspaceDirectory(cwd), 'mcp-overrides.json')
  const globalData = applyConfigFile(servers, globalPath, 'global', errors)
  const projectData = applyConfigFile(servers, projectPath, 'project', errors)
  const overrideData = applyConfigFile(servers, overridePath, 'project', errors)

  for (const [name, entry] of servers) {
    const config = structuredClone(entry.config) as unknown as Record<string, unknown>
    if (legacyDisabled) {
      const authorization = mcpAuthorization(config)
      const globalAuthorizations = isObject(globalData?.desktopAuthorizedServers)
        ? globalData.desktopAuthorizedServers
        : {}
      const workspaceAuthorizations = isObject(overrideData?.desktopAuthorizedServers)
        ? overrideData.desktopAuthorizedServers
        : {}
      if (globalAuthorizations[name] !== authorization && workspaceAuthorizations[name] !== authorization)
        config.enabled = false
    }
    const oauth = isObject(config.oauth) ? { ...config.oauth } : undefined
    if (oauth) {
      delete oauth.clientSecret
      const secret = credentials.get(`mcp-oauth-client:${name}`)
      if (secret) oauth.clientSecret = secret
      config.oauth = oauth
    }
    servers.set(name, { ...entry, config: config as unknown as McpServerConfig })
  }

  const codemode = [globalData, projectData, overrideData]
    .reverse()
    .find((data) => isObject(data) && typeof data.autoEnableCodemode === 'boolean')
  return {
    servers: [...servers.values()],
    autoEnableCodemode: isObject(codemode) ? (codemode.autoEnableCodemode as boolean) : undefined,
    errors,
  }
}

class DesktopMcpOAuthCredentials {
  private locks = new Map<string, Promise<unknown>>()

  constructor(private readonly storage: SecureCredentialStorage) {}

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
      save: (value: McpOAuthState) => this.storage.set(key, JSON.stringify(value)),
      withRefreshLock: async <T>(fn: () => Promise<T>): Promise<T> => {
        const previous = this.locks.get(key) ?? Promise.resolve()
        let release!: () => void
        const lock = new Promise<void>((resolve) => (release = resolve))
        const tail = previous.catch(() => {}).then(() => lock)
        this.locks.set(key, tail)
        await previous.catch(() => {})
        try {
          return await fn()
        } finally {
          release()
          if (this.locks.get(key) === tail) this.locks.delete(key)
        }
      },
    }
  }

  tokens(name: string, serverUrl: string) {
    return this.state(this.key(name, serverUrl))?.tokens
  }

  remove(name: string, serverUrl: string) {
    return this.storage.delete(this.key(name, serverUrl))
  }
}

function writeWorkspaceOverride(filePath: string, name: string, patch: McpConfigPatch, authorization?: string) {
  let data: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
    if (isObject(parsed) && isObject(parsed.mcpServers)) data = parsed
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

export function createDesktopMcpExtension(
  sdk: typeof import('@earendil-works/pi-coding-agent'),
  paths: PiRuntimePaths,
  credentials: SecureCredentialStorage,
  cwd: string,
  legacyDisabled = false,
  plan?: PlanMcpOptions,
): InlineExtension {
  const options: NonNullable<Parameters<typeof sdk.createMcpExtension>[0]> = {
    loadConfig: (context) => loadDesktopMcpConfig(paths, context.cwd, credentials, legacyDisabled),
    credentials: new DesktopMcpOAuthCredentials(credentials) as unknown as NonNullable<
      NonNullable<Parameters<typeof sdk.createMcpExtension>[0]>['credentials']
    >,
    logPath: path.join(paths.dataRoot, 'logs', 'mcp.log'),
    updateConfig: (entry: McpServerEntry, patch: McpConfigPatch) => {
      writeDesktopMcpWorkspaceOverride(paths, cwd, entry.name, patch, mcpAuthorization({ ...entry.config, ...patch }))
    },
  }
  return {
    name: 'pi-meme-mcp',
    factory: (pi) => {
      const planning = plan?.active() === true
      const extension = sdk.createMcpExtension({
        ...options,
        ...(planning ? { createTransport: createPlanTransport(plan!.sandbox) } : {}),
      })
      return extension(
        new Proxy(pi, {
          get(target, key, receiver) {
            if (key === 'registerTool')
              return (tool: ToolDefinition) => {
                if (planning)
                  plan!.register(tool.name, {
                    readOnly:
                      tool.annotations?.readOnlyHint === true
                        ? true
                        : tool.annotations?.destructiveHint === true
                          ? false
                          : undefined,
                  })
                target.registerTool(
                  planning && tool.annotations?.readOnlyHint !== true && tool.annotations?.destructiveHint === true
                    ? { ...tool, exposure: 'hidden' }
                    : tool,
                )
              }
            return Reflect.get(target, key, receiver)
          },
        }) as ExtensionAPI,
      )
    },
  }
}
