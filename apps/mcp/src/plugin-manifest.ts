import { mkdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import ipaddr from 'ipaddr.js'
import manifest from '../package.json' with { type: 'json' }
import { publicEndpoint } from './config'

export function pluginManifests(address: string) {
  const url = publicEndpoint(address)
  const hostname = url.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase()
  if (ipaddr.isValid(hostname)) {
    let ip = ipaddr.parse(hostname)
    if (ip.kind() === 'ipv6' && (ip as ipaddr.IPv6).isIPv4MappedAddress()) ip = (ip as ipaddr.IPv6).toIPv4Address()
    if (ip.range() !== 'unicast') throw new Error('Rakazo 插件需要公网 HTTPS 地址，不接受回环、私网或保留 IP')
  } else if (
    !hostname.includes('.') ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(hostname) ||
    /(?:^|\.)example\.(?:com|org|net)$/.test(hostname)
  ) {
    throw new Error('Rakazo 插件需要实际公网域名，不接受本地域名或示例域名')
  }
  const schema = 'https://agent-plugins.org/schemas/1.1.0'
  return {
    plugin: {
      $schema: `${schema}/plugin.schema.json`,
      name: 'pi-meme',
      version: manifest.version,
      description: 'Connect Pi meme projects, conversations, tasks, files, and schedules through MCP.',
      homepage: 'https://github.com/xidongdong-153/Pi-meme',
      license: 'MIT',
      keywords: ['pi-meme', 'coding', 'projects', 'mcp'],
    },
    mcp: {
      $schema: `${schema}/mcp.schema.json`,
      mcpServers: { 'pi-meme': { type: 'streamable-http', url: url.href } },
    },
  }
}

export async function generatePlugin(address: string, output: string) {
  const files = pluginManifests(address)
  const directory = path.resolve(output)
  await mkdir(path.dirname(directory), { recursive: true })
  await mkdir(directory)
  const readme =
    `# Pi meme\n\nMCP endpoint: ${files.mcp.mcpServers['pi-meme'].url}\n\n` +
    'Publish this folder in a public GitHub repository. In Rakazo: Integrations → + → From GitHub → Preview → Connect.\n\n' +
    'Then open Manage MCP servers → edit Pi meme → Advanced → Access token, and enter the MCP bearer token supplied by the server owner. Never publish the token, a Host login token, or an Authorization header in these files.\n\n' +
    'With a bot selected, choose Use in this bot. Ask it to call pi_meme_hosts, pi_meme_capabilities, and pi_meme_projects_list.\n\n' +
    'Writes are disabled by default. To delegate work, the server owner must authorize writes and a project; create a session and submit a task with a stable idempotencyKey, then inspect the receipt and messages. An accepted receipt is not a completed task.\n\n' +
    'This connector requires a reachable public HTTPS server; generating files does not deploy it or verify connectivity. It uses a bearer token, not OAuth. Local stdio and private network endpoints are not supported by Rakazo plugins.\n'
  await Promise.all([
    writeFile(path.join(directory, 'plugin.json'), `${JSON.stringify(files.plugin, null, 2)}\n`, { flag: 'wx' }),
    writeFile(path.join(directory, 'mcp.json'), `${JSON.stringify(files.mcp, null, 2)}\n`, { flag: 'wx' }),
    writeFile(path.join(directory, 'README.md'), readme, { flag: 'wx' }),
  ])
  return directory
}

async function main() {
  const { values } = parseArgs({
    options: { url: { type: 'string' }, out: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  })
  if (values.help) {
    console.log(
      '生成 Rakazo 插件：--url https://实际公网域名/mcp [--out out/mcp-plugin]；输出目录必须不存在，不写凭据。',
    )
    return
  }
  if (!values.url) throw new Error('请传 --url 指定已部署的公网 HTTPS MCP 地址')
  const output = await generatePlugin(values.url, values.out ?? 'out/mcp-plugin')
  console.log(`已生成 ${output}/plugin.json、mcp.json 和 README.md；未部署、发布或执行 Rakazo 安装。`)
}

const entry = process.argv[1] ? await realpath(path.resolve(process.argv[1])).catch(() => undefined) : undefined
if (entry && entry === (await realpath(fileURLToPath(import.meta.url)))) {
  await main().catch((cause: unknown) => {
    console.error(cause instanceof Error ? cause.message : '插件配置生成失败')
    process.exitCode = 1
  })
}
