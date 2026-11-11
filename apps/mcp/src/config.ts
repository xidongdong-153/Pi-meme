import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { z } from 'zod'

const envName = z.string().regex(/^[A-Za-z_]\w{0,127}$/)
const identifier = z.string().min(1).max(128).regex(/^\S+$/)
const loopbackNames = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

function hostAddress(value: string) {
  const url = new URL(value)
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopbackNames.has(url.hostname)))
  ) {
    throw new Error('Host URL 必须是无账号、查询、片段的服务根地址；远程使用 HTTPS，本机回环可使用 HTTP')
  }
  return url.origin
}

export function publicEndpoint(value: string) {
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.endsWith('/mcp')
  ) {
    throw new Error('公开 MCP URL 必须是无账号、查询、片段并以 /mcp 结尾的 HTTPS 地址')
  }
  return url
}

const hostSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/),
    url: z.string().max(2048).transform(hostAddress),
    tokenEnv: envName,
    hostId: identifier.optional(),
    allowWrites: z.boolean().default(false),
    allowProjectRegistration: z.boolean().default(false),
    projectIds: z.array(identifier).max(2000).optional(),
    allowStandaloneSessions: z.boolean().optional(),
  })
  .strict()

const configSchema = z
  .object({
    transport: z.enum(['http', 'stdio']).default('http'),
    hostname: z.string().min(1).max(253).default('127.0.0.1'),
    port: z.number().int().min(0).max(65535).default(4311),
    tokenEnv: envName.default('PI_MEME_MCP_TOKEN'),
    clientId: z.string().min(1).max(64).regex(/^\S+$/).default('pi-meme-mcp'),
    publicUrl: z.string().max(2048).optional(),
    allowedOrigins: z.array(z.string().max(2048)).max(32).default([]),
    tlsCertEnv: envName.optional(),
    tlsKeyEnv: envName.optional(),
    requestTimeoutMs: z.number().int().min(1000).max(300000).default(30000),
    hosts: z.array(hostSchema).min(1).max(32),
  })
  .strict()

export type HostConfiguration = Omit<z.infer<typeof hostSchema>, 'allowStandaloneSessions'> & {
  token: string
  allowStandaloneSessions: boolean
}
export type McpConfiguration = Omit<z.infer<typeof configSchema>, 'hosts'> & {
  hosts: HostConfiguration[]
  token?: string
  tls?: { cert: Buffer; key: Buffer }
}

function booleanEnvironment(environment: NodeJS.ProcessEnv, key: string) {
  const value = environment[key]
  if (value === undefined || value === 'false') return false
  if (value === 'true') return true
  throw new Error(`${key} 只接受 true 或 false`)
}

function secret(environment: NodeJS.ProcessEnv, key: string, minimum = 1) {
  const value = environment[key]
  if (!value || value.length < minimum || value.length > 512 || /\s/.test(value)) {
    throw new Error(`请设置 ${key}：${minimum}–512 字符，不含空白；不要将令牌写入配置或 URL`)
  }
  return value
}

export async function loadConfiguration(
  options: { file?: string; transport?: string } = {},
  environment: NodeJS.ProcessEnv = process.env,
): Promise<McpConfiguration> {
  let input: unknown
  const file = options.file ?? environment.PI_MEME_MCP_CONFIG
  if (file) {
    const bytes = await readFile(file)
    if (bytes.length > 1024 * 1024) throw new Error('MCP 配置文件不能超过 1 MiB')
    try {
      input = JSON.parse(bytes.toString('utf8'))
    } catch {
      throw new Error('MCP 配置文件必须是有效 JSON')
    }
  } else {
    if (environment.PI_MEME_MCP_PORT !== undefined && !environment.PI_MEME_MCP_PORT.trim()) {
      throw new Error('MCP 配置无效：PI_MEME_MCP_PORT 不能为空；省略使用 4311，显式 0 才分配临时端口')
    }
    input = {
      transport: environment.PI_MEME_MCP_TRANSPORT,
      hostname: environment.PI_MEME_MCP_HOST,
      port: environment.PI_MEME_MCP_PORT === undefined ? undefined : Number(environment.PI_MEME_MCP_PORT),
      publicUrl: environment.PI_MEME_MCP_PUBLIC_URL,
      tlsCertEnv: environment.PI_MEME_MCP_TLS_CERT ? 'PI_MEME_MCP_TLS_CERT' : undefined,
      tlsKeyEnv: environment.PI_MEME_MCP_TLS_KEY ? 'PI_MEME_MCP_TLS_KEY' : undefined,
      hosts: [
        {
          name: 'local',
          url: environment.PI_MEME_HOST_URL ?? 'http://127.0.0.1:3185',
          tokenEnv: 'PI_MEME_HOST_TOKEN',
          hostId: environment.PI_MEME_HOST_ID,
          allowWrites: booleanEnvironment(environment, 'PI_MEME_MCP_ALLOW_WRITE'),
          allowProjectRegistration: booleanEnvironment(environment, 'PI_MEME_MCP_ALLOW_PROJECT_REGISTRATION'),
        },
      ],
    }
  }
  const parsed = configSchema.safeParse(input)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`)
    throw new Error(`MCP 配置无效：${issues.join('；')}`)
  }
  const config = parsed.data
  if (options.transport !== undefined) {
    if (options.transport !== 'http' && options.transport !== 'stdio')
      throw new Error('MCP 配置无效：transport 只接受 http 或 stdio')
    config.transport = options.transport
  }
  const names = new Set<string>()
  const hosts = config.hosts.map((host): HostConfiguration => {
    if (names.has(host.name)) throw new Error(`Host 名称重复：${host.name}`)
    names.add(host.name)
    if (host.allowProjectRegistration && (!host.allowWrites || host.projectIds !== undefined)) {
      throw new Error(`${host.name}：项目登记需要 allowWrites=true 且不能与 projectIds 限定同时开启`)
    }
    return {
      ...host,
      allowStandaloneSessions: host.allowStandaloneSessions ?? host.projectIds === undefined,
      token: secret(environment, host.tokenEnv),
    }
  })
  const publicUrl = config.publicUrl ? publicEndpoint(config.publicUrl) : undefined
  const allowedOrigins = config.allowedOrigins.map((value) => {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin !== value) {
      throw new Error('allowedOrigins 仅接受完整 HTTP(S) origin，不包含路径、账号、查询或片段')
    }
    return url.origin
  })
  if (publicUrl) allowedOrigins.push(publicUrl.origin)
  let tls: McpConfiguration['tls']
  if (Boolean(config.tlsCertEnv) !== Boolean(config.tlsKeyEnv)) throw new Error('HTTPS 证书与私钥必须同时配置')
  if (config.tlsCertEnv && config.tlsKeyEnv) {
    const certPath = environment[config.tlsCertEnv]
    const keyPath = environment[config.tlsKeyEnv]
    if (!certPath || !keyPath) throw new Error('HTTPS 证书与私钥的环境变量未设置')
    tls = { cert: await readFile(certPath), key: await readFile(keyPath) }
  }
  if (config.transport === 'http' && !loopbackNames.has(config.hostname) && !tls) {
    throw new Error('非回环监听必须配置 HTTPS 证书与私钥；反向代理部署请让 MCP 仅监听 127.0.0.1')
  }
  const token = config.transport === 'http' ? secret(environment, config.tokenEnv, 32) : undefined
  if (token && !/^[\w.~+/-]+=*$/.test(token))
    throw new Error(`${config.tokenEnv} 必须使用 ASCII Bearer token 字符；建议生成随机十六进制令牌`)
  if (token && hosts.some((host) => host.token === token)) throw new Error('MCP 令牌必须与 Host 登录令牌不同')
  return { ...config, hosts, token, tls, allowedOrigins: [...new Set(allowedOrigins)] }
}
