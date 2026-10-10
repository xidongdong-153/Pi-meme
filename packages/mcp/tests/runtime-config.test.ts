import assert from 'node:assert/strict'
import { test } from 'node:test'
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
