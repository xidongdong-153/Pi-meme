import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  McpAuthRequiredError,
  McpClient,
  McpHttpError,
  StdioTransport,
  StreamableHttpTransport,
  type AuthProvider,
} from '@earendil-works/pi-mcp'
import {
  createMcpAuthProvider,
  McpOAuthAuthorizationRequiredError,
  type McpOAuthClientOptions,
  type OAuthChallenge,
} from '@earendil-works/pi-mcp/oauth'
import type { McpServerConfig } from '@earendil-works/pi-coding-agent'
import type { McpCheck, McpService } from '@pi-meme/contracts/mcp'
import { serviceProcessEnvironment } from '@pi-meme/pi-runtime/sdk/managed-process'
import type { DesktopMcpOAuthCredentials } from './runtime-config'

type Http = Extract<McpServerConfig, { url: string }>
export function authentication(config: McpServerConfig): McpService['authentication'] {
  if (!('url' in config)) return 'environment'
  if (config.auth) return 'provider'
  return Object.keys(config.headers ?? {}).some((key) => key.toLowerCase() === 'authorization') ? 'headers' : 'auto'
}

// Pi supports whole-value shell commands and escaped/interpolated environment variables in credentials.
function resolveValue(value: string) {
  if (value.startsWith('!')) {
    const command = value.slice(1)
    try {
      const result = execFileSync(
        process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
        process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command],
        { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
      ).trim()
      if (result) return result
    } catch {
      /* The command may contain a secret. */
    }
    throw new Error('凭据命令未返回有效值')
  }
  return value.replace(
    /\$(\$|!|\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g,
    (_match, token: string, braced?: string, plain?: string) => {
      const name = braced ?? plain
      if (!name) return token
      if (!process.env[name]) throw new Error(`Host 环境变量 ${name} 未设置`)
      return process.env[name]!
    },
  )
}
function resolveValues(input?: Record<string, string>) {
  return Object.fromEntries(Object.entries(input ?? {}).map(([key, value]) => [key, resolveValue(value)]))
}
function expandHome(value: string) {
  return value === '~'
    ? homedir()
    : /^~\//.test(value) || (process.platform === 'win32' && value.startsWith('~\\'))
      ? path.join(homedir(), value.slice(2))
      : value
}
class PrivateStdioTransport extends StdioTransport {
  override get stderr() {
    return ''
  }

  override async start() {
    try {
      await super.start()
    } catch {
      throw new Error('MCP 本地进程启动失败')
    }
  }
}

export function createMcpTransport(
  config: McpServerConfig,
  cwd: string,
  authProvider?: AuthProvider,
  openGetStream = true,
) {
  return 'url' in config
    ? new StreamableHttpTransport({
        url: config.url,
        headers: resolveValues(config.headers),
        authProvider,
        openGetStream,
        fetch: async (input, init) => {
          const response = await fetch(input, { ...init, redirect: 'error' })
          if (response.ok) return response
          await response.body?.cancel().catch(() => {})
          return new Response(null, { status: response.status, headers: response.headers })
        },
      })
    : new PrivateStdioTransport({
        command: expandHome(config.command),
        args: config.args?.map(expandHome),
        env: Object.fromEntries(
          Object.entries(serviceProcessEnvironment(resolveValues(config.env))).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
        inheritEnv: false,
        cwd: path.resolve(cwd, expandHome(config.cwd ?? '.')),
        stderr: 'pipe',
        maxStderrBytes: 1,
      })
}

export function oauthClient(
  name: string,
  config: Http,
  credentials: DesktopMcpOAuthCredentials,
): McpOAuthClientOptions {
  const { clientSecret, authServerMetadataUrl, ...options } = config.oauth ?? {}
  return {
    clientName: 'pi',
    serverUrl: config.url,
    store: credentials.forServer(name, config.url),
    clientMetadataDocuments: {
      baseUrl: 'https://pi.dev/oauth',
      listsRedirectUrl(value) {
        if (!URL.canParse(value)) return false
        const url = new URL(value)
        return (
          url.protocol === 'http:' &&
          ['localhost', '127.0.0.1'].includes(url.hostname) &&
          url.pathname === '/callback' &&
          !url.search &&
          !url.hash &&
          !url.username &&
          !url.password
        )
      },
    },
    settings: {
      ...options,
      clientSecret: clientSecret ? resolveValue(clientSecret) : undefined,
      authServerMetadataUrl: authServerMetadataUrl ? new URL(authServerMetadataUrl) : undefined,
    },
  }
}
export async function probeMcpService(
  name: string,
  config: McpServerConfig,
  cwd: string,
  credentials: DesktopMcpOAuthCredentials,
  providerToken: (id: string) => Promise<string | undefined>,
) {
  let challenge: OAuthChallenge | undefined
  const checkedAt = new Date().toISOString()
  const timeoutMs = Math.min((config.timeout ?? 30) * 1000, 90_000)
  const client = new McpClient({
    name: 'pi-meme',
    version: '1',
    requestTimeoutMs: timeoutMs,
    roots: [{ uri: pathToFileURL(cwd).href, name: path.basename(cwd) }],
  })
  let auth: ReturnType<typeof createMcpAuthProvider> | undefined
  const timer = setTimeout(() => void client.close().catch(() => {}), timeoutMs)
  let check: McpCheck
  try {
    if ('url' in config && authentication(config) === 'auto') {
      const options = oauthClient(name, config, credentials)
      auth = createMcpAuthProvider({
        ...options,
        settings: () => options.settings,
        onChallenge: (value) => {
          challenge = value
        },
      })
    }
    const provider = 'url' in config ? config.auth?.provider : undefined
    const transport = createMcpTransport(
      config,
      cwd,
      auth ?? (provider ? { token: () => providerToken(provider) } : undefined),
      false,
    )
    await client.connect(transport)
    const tools = client.serverCapabilities?.tools ? (await client.listTools()).length : 0
    check = { state: 'connected', checkedAt, tools }
  } catch (error) {
    const needsAuth = error instanceof McpOAuthAuthorizationRequiredError || error instanceof McpAuthRequiredError
    check = {
      state: needsAuth ? 'needs-auth' : 'failed',
      checkedAt,
      message: needsAuth
        ? authentication(config) === 'headers'
          ? '服务拒绝了请求头中的凭据'
          : '服务要求登录或补充授权'
        : error instanceof McpHttpError
          ? `服务返回 HTTP ${error.status}`
          : '连接失败，请检查服务地址、启动配置与网络',
    }
  } finally {
    clearTimeout(timer)
    await client.close().catch(() => {})
    await auth?.settled()
  }
  return { check, challenge }
}
