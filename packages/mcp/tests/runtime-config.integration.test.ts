import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createPiRuntimePaths } from '@pi-meme/pi-runtime/runtime-paths'
import { MemoryCredentialStorage } from '@pi-meme/pi-runtime/secure-store'
import { loadDesktopMcpConfig, writeDesktopMcpWorkspaceOverride } from '../src/server/runtime-config'

test('MCP 配置按 Desktop 全局、项目 .pi、Desktop 工作区覆盖顺序合并', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-mcp-runtime-config-'))
  const userData = path.join(directory, 'userData')
  const cwd = path.join(directory, 'project')
  const paths = createPiRuntimePaths(userData)
  const globalFile = path.join(paths.agentDir, 'mcp.json')
  const projectFile = path.join(cwd, '.pi', 'mcp.json')
  await mkdir(paths.agentDir, { recursive: true })
  await mkdir(path.dirname(projectFile), { recursive: true })
  await writeFile(
    globalFile,
    JSON.stringify({
      autoEnableCodemode: true,
      mcpServers: {
        shared: {
          url: 'https://global.example/mcp',
          enabled: true,
          oauth: { clientId: 'global-client', clientSecret: 'global-plaintext-secret' },
        },
        globalOnly: { command: 'node', args: ['global-server.mjs'] },
      },
    }),
  )
  await writeFile(
    projectFile,
    JSON.stringify({
      autoEnableCodemode: true,
      mcpServers: {
        shared: {
          url: 'http://localhost/project-mcp',
          enabled: true,
          oauth: { clientId: 'project-client', clientSecret: 'project-plaintext-secret' },
        },
        projectOnly: { url: 'http://localhost/project-only' },
      },
    }),
  )
  const originalProjectFile = await readFile(projectFile, 'utf8')
  try {
    writeDesktopMcpWorkspaceOverride(paths, cwd, 'shared', { enabled: false, exposure: 'hidden' })
    writeDesktopMcpWorkspaceOverride(paths, cwd, 'projectOnly', { enabled: false })
    const credentials = new MemoryCredentialStorage()
    credentials.set('mcp-oauth-client:shared', 'desktop-encrypted-secret')
    const loaded = loadDesktopMcpConfig(paths, cwd, credentials)
    const shared = loaded.servers.find((server) => server.name === 'shared')!
    const sharedConfig = shared.config as unknown as {
      url: string
      enabled: boolean
      exposure: string
      oauth: { clientId: string; clientSecret: string }
    }

    assert.equal(sharedConfig.url, 'http://localhost/project-mcp')
    assert.equal(sharedConfig.enabled, false)
    assert.equal(sharedConfig.exposure, 'hidden')
    assert.equal(sharedConfig.oauth.clientId, 'project-client')
    assert.equal(sharedConfig.oauth.clientSecret, 'desktop-encrypted-secret')
    assert.equal(shared.source, projectFile)
    assert.equal(shared.override, path.join(paths.workspaceDirectory(cwd), 'mcp-overrides.json'))
    assert.equal(loaded.autoEnableCodemode, true)
    assert.deepEqual(loaded.servers.map((server) => server.name).sort(), ['globalOnly', 'projectOnly', 'shared'])
    assert.equal(await readFile(projectFile, 'utf8'), originalProjectFile)
    assert.equal(
      JSON.parse(await readFile(path.join(paths.workspaceDirectory(cwd), 'mcp-overrides.json'), 'utf8')).mcpServers
        .shared.enabled,
      false,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('旧MCP关闭记录不连接旧全局和项目服务，仅显式授权的配置生效', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-mcp-legacy-deny-'))
  const paths = createPiRuntimePaths(path.join(directory, 'data'))
  const cwd = path.join(directory, 'project')
  const globalFile = path.join(paths.agentDir, 'mcp.json')
  const projectFile = path.join(cwd, '.pi', 'mcp.json')
  await mkdir(paths.agentDir, { recursive: true })
  await mkdir(path.dirname(projectFile), { recursive: true })
  await writeFile(
    globalFile,
    JSON.stringify({
      mcpServers: { shared: { url: 'https://global.example/mcp' }, global: { command: 'node', args: ['global.js'] } },
    }),
  )
  await writeFile(
    projectFile,
    JSON.stringify({
      mcpServers: {
        shared: { url: 'https://project.example/mcp' },
        project: { command: 'node', args: ['project.js'] },
      },
    }),
  )
  const original = await readFile(projectFile, 'utf8')
  const credentials = new MemoryCredentialStorage()
  try {
    assert.ok(
      loadDesktopMcpConfig(paths, cwd, credentials, true).servers.every((entry) => entry.config.enabled === false),
    )
    const { McpConfigStore } = await import('../src/server/config-store')
    const store = new McpConfigStore(globalFile, credentials)
    const loaded = await store.snapshot()
    await store.save({
      revision: loaded.revision,
      name: 'global',
      previousName: 'global',
      config: { command: 'node', args: ['global.js'], enabled: true },
    })
    const next = loadDesktopMcpConfig(paths, cwd, credentials, true)
    assert.equal(next.servers.find((entry) => entry.name === 'global')?.config.enabled, true)
    assert.equal(next.servers.find((entry) => entry.name === 'shared')?.config.enabled, false)
    assert.equal(next.servers.find((entry) => entry.name === 'project')?.config.enabled, false)
    assert.equal(await readFile(projectFile, 'utf8'), original)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test(
  'Plan MCP 使用只读独立进程，实际拒绝业务文件写入并保留 JSON-RPC 通信',
  { skip: !['darwin', 'linux'].includes(process.platform) },
  async () => {
    const { AccessSandbox } = await import('@pi-meme/pi-runtime/sdk/access-sandbox')
    const { createPlanTransport } = await import('../src/server/plan-transport')
    const directory = await mkdtemp(path.join(tmpdir(), 'pi-plan-mcp-'))
    const cwd = path.join(directory, 'project')
    const temporary = path.join(directory, 'temporary')
    await mkdir(cwd)
    await mkdir(temporary)
    const target = path.join(cwd, 'business.txt')
    await writeFile(target, '保留内容')
    const sandbox = await AccessSandbox.create({
      mode: 'read-only',
      cwd,
      temporary,
      agentDir: path.join(directory, 'agent'),
    })
    const script = `const fs=require('node:fs');process.stdin.on('data', chunk=>{const request=JSON.parse(chunk);let denied=false;try{fs.writeFileSync(${JSON.stringify(target)},'不应写入')}catch{denied=true}console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{denied}}))})`
    const transport = createPlanTransport(() => sandbox)(
      {
        name: 'fixture',
        config: { command: process.execPath, args: ['-e', script] },
        source: 'fixture',
        scope: 'global',
      },
      cwd,
      undefined,
    )
    try {
      const response = new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('MCP 测试超时')), 5000)
        transport.onMessage((message) => {
          clearTimeout(timer)
          resolve(message)
        })
        transport.onError((error) => {
          clearTimeout(timer)
          reject(error)
        })
      })
      await transport.send({ jsonrpc: '2.0', id: 1, method: 'probe' })
      assert.deepEqual(await response, { jsonrpc: '2.0', id: 1, result: { denied: true } })
      assert.equal(await readFile(target, 'utf8'), '保留内容')
    } finally {
      await transport.close()
      await sandbox.stopAll()
      await rm(directory, { recursive: true, force: true })
    }
  },
)

test('MCP 查询和通用脚本默认可用，明确破坏性的工具隐藏', async () => {
  const { createDesktopMcpExtension } = await import('../src/server/runtime-config')
  const tools = new Map<string, import('@pi-meme/contracts/plan').PlanToolSource>()
  const registered: Array<{ name: string; exposure?: string }> = []
  const definitions = [
    {
      name: 'query',
      annotations: { readOnlyHint: true },
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
    },
    {
      name: 'script',
      annotations: { readOnlyHint: true },
      parameters: { type: 'object', properties: { code: { type: 'string' } } },
    },
    {
      name: 'navigate',
      annotations: { readOnlyHint: false, destructiveHint: false },
      parameters: { type: 'object', properties: { url: { type: 'string' } } },
    },
    {
      name: 'delete',
      annotations: { readOnlyHint: false, destructiveHint: true },
      parameters: { type: 'object', properties: {} },
    },
  ]
  const sdk = {
    createMcpExtension: () => (api: { registerTool: (tool: unknown) => void }) => {
      for (const definition of definitions) api.registerTool(definition)
    },
  }
  const extension = createDesktopMcpExtension(
    sdk as never,
    createPiRuntimePaths(path.join(tmpdir(), 'pi-plan-registry-fixture')),
    new MemoryCredentialStorage(),
    '/project',
    false,
    {
      active: () => true,
      sandbox: () => {
        throw new Error('不启动进程')
      },
      register: (name, source) => tools.set(name, source),
    },
  )
  const api = { registerTool: (tool: { name: string; exposure?: string }) => registered.push(tool) }
  await (typeof extension === 'function' ? extension(api as never) : extension.factory(api as never))
  assert.equal(tools.get('query')!.readOnly, true)
  assert.equal(tools.get('script')!.readOnly, true)
  assert.equal(tools.get('navigate')!.readOnly, undefined)
  assert.equal(tools.get('delete')!.readOnly, false)
  assert.equal(registered.find((tool) => tool.name === 'delete')!.exposure, 'hidden')
})
