import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { createServer } from 'node:net'
import { spawnWindowsProcess } from '@pi-meme/windows-native/process'
import { createNodeHostClient } from '@pi-meme/client/node-host-client'
import { readLocalHostStatus } from '@pi-meme/host/host-status'
import { initEmptyStorageLayout } from '@pi-meme/host/storage/upgrade'
import { storageLayoutRelativePaths } from '@pi-meme/contracts/storage-paths'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'
import type { PluginGrant } from '@pi-meme/plugin-sdk/permissions'

const execute = promisify(execFile)
async function until<T>(read: () => Promise<T | undefined>, diagnostic: () => string): Promise<T> {
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await delay(100)
  }
  throw new Error(`Windows 包验收超时：${diagnostic()}`)
}

test(
  'Windows ZIP 在中文空格目录启动，独立运行 Host、Worker、原生字体与 ConPTY',
  { skip: process.platform !== 'win32', timeout: 120000 },
  async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'Pi meme 中文 包验收 ')))
    const application = path.join(root, '应用 空格')
    const dataRoot = path.join(root, '数据 目录')
    const workspace = path.join(root, '中文 项目')
    const fixedNode = path.join(application, 'resources/runtime/bin/node.exe')
    const outside = path.join(root, '包外原文件.txt')
    const fake = await useFakeAgent(root, {
      reply: (body) => {
        const prompt = JSON.stringify(body.messages.filter((message: { role: string }) => message.role === 'user'))
        if (body.messages.at(-1)?.role === 'user') {
          if (prompt.includes('PACKAGE_RESTRICTED')) return { tool: { name: 'package_probe', arguments: '{}' } }
          if (prompt.includes('PACKAGE_PSEC')) {
            const code = `const fs=require('node:fs');const write=p=>{try{fs.writeFileSync(p,'allowed');return true}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e;return false}};console.log(JSON.stringify({workspace:write('business.txt'),outside:write(${JSON.stringify(outside)})}))`
            const launcher = `eval(Buffer.from('${Buffer.from(code).toString('base64')}','base64').toString())`
            return {
              tool: {
                name: 'powershell',
                arguments: JSON.stringify({
                  command: `& '${fixedNode.replaceAll("'", "''")}' -e '${launcher.replaceAll("'", "''")}'`,
                }),
              },
            }
          }
        }
        return 'Windows 安装包回复'
      },
    })
    let child: Awaited<ReturnType<typeof spawnWindowsProcess>> | undefined
    let client: Awaited<ReturnType<typeof createNodeHostClient>> | undefined
    let logs = ''
    try {
      await Promise.all([mkdir(application), mkdir(workspace), writeFile(outside, 'original')])
      const version = (JSON.parse(await readFile('apps/desktop/package.json', 'utf8')) as { version: string }).version
      const archive = path.resolve(`out/release/pi-meme-desktop-${version}-windows-x64.zip`)
      await execute('tar.exe', ['-xf', archive, '-C', application], { windowsHide: true })
      const metadata = JSON.parse(await readFile(path.join(application, 'resources/release.json'), 'utf8'))
      assert.equal(metadata.version, version)
      assert.equal(metadata.platform, 'win32')
      assert.equal(metadata.arch, 'x64')
      const runtime = path.join(application, 'resources/runtime')
      assert.ok((await readFile(path.join(runtime, 'WINDOWS_NATIVE_LICENSES.txt'), 'utf8')).length > 0)
      assert.equal((await execute(path.join(runtime, 'bin/node.exe'), ['--version'])).stdout.trim(), 'v24.14.0')
      const fonts = JSON.parse((await execute(path.join(runtime, 'bin/pi-meme-windows.exe'), ['fonts'])).stdout)
      assert.ok(fonts.length > 0)
      await initEmptyStorageLayout(dataRoot)
      await Promise.all([
        mkdir(path.join(dataRoot, storageLayoutRelativePaths.agentDirectory), { recursive: true }),
        mkdir(path.join(dataRoot, storageLayoutRelativePaths.credentialsDirectory), { recursive: true }),
      ])
      await writeFile(path.join(dataRoot, storageLayoutRelativePaths.agentModelsFile), await readFile(fake.modelsFile))
      await writeFile(
        path.join(dataRoot, storageLayoutRelativePaths.authFile),
        JSON.stringify(Object.fromEntries(fake.credentials.entries())),
      )
      const listener = createServer()
      await new Promise<void>((resolve, reject) => {
        listener.once('error', reject)
        listener.listen(0, '127.0.0.1', resolve)
      })
      const address = listener.address()
      assert.ok(address && typeof address === 'object')
      const port = address.port
      await new Promise<void>((resolve) => listener.close(() => resolve()))
      const environment = { ...process.env }
      for (const key of Object.keys(environment))
        if (
          key.toLowerCase() === 'path' ||
          /^(?:NODE_OPTIONS|NODE_PATH|PI_MEME_PLUGIN_NODE|PI_MEME_PLUGIN_ENTRY|PI_MEME_WINDOWS_NATIVE)$/i.test(key)
        )
          delete environment[key]
      environment.PATH = [
        path.join(process.env.SystemRoot!, 'System32'),
        path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0'),
      ].join(';')
      Object.assign(environment, {
        PI_MEME_DATA_ROOT: dataRoot,
        PI_MEME_TEST_CREDENTIALS: 'file',
        PI_MEME_PORT: String(port),
      })
      child = await spawnWindowsProcess(path.join(application, 'Pi meme.exe'), [], {
        cwd: application,
        env: environment,
      })
      child.stdin.end()
      for (const stream of [child.stdout, child.stderr])
        stream.on('data', (chunk: Buffer) => {
          logs = (logs + chunk.toString()).slice(-16000)
        })
      const url = `http://127.0.0.1:${port}`
      const status = await until(
        () => readLocalHostStatus(url),
        () => logs,
      )
      assert.equal(status.owner, 'desktop')
      assert.equal(status.dataRoot, dataRoot)
      client = await createNodeHostClient({ url, token: '', hostId: status.hostId, clientId: 'windows-artifact' })
      const mutation = () => ({ idempotencyKey: randomUUID() })
      const project = await client.projects.register({ cwd: workspace, name: '中文 项目' }, mutation())
      assert.equal(project.cwd, workspace)
      const terminal = await client.terminal.open(project, { cols: 80, rows: 24 }, mutation())
      await client.terminal.input(terminal, "[Console]::WriteLine('WINDOWS_包_终端'); exit\r", mutation())
      const output = await until(
        async () => {
          const snapshot = await client!.terminal.attach(terminal)
          return snapshot.exited && snapshot.output.includes('WINDOWS_包_终端') ? snapshot : undefined
        },
        () => logs,
      )
      assert.equal(output.exitCode, 0)
      const session = await client.sessions.create(
        { project, configuration: { model: { provider: 'fake', id: 'first' }, accessMode: 'full-access' } },
        mutation(),
      )
      await client.sessions.submit(session, { delivery: 'start', text: '验证 Windows 安装包' }, mutation())
      await until(
        async () => {
          const snapshot = await client!.sessions.snapshot(session)
          return JSON.stringify(snapshot.messages).includes('Windows 安装包回复') ? true : undefined
        },
        () => logs,
      )
      assert.ok(fake.provider.requests.length > 0)
      for (const mode of ['plan', 'workspace-write'] as const) {
        const ref = await client.sessions.create(
          {
            project,
            configuration: {
              model: { provider: 'fake', id: 'first' },
              accessMode: mode === 'plan' ? 'full-access' : 'workspace-write',
            },
          },
          mutation(),
        )
        const initial = await client.sessions.snapshot(ref)
        assert.equal(initial.connection.restrictedAccessSupported, true, initial.connection.restrictedAccessReason)
        await client.sessions.submit(
          ref,
          { delivery: 'start', text: `PACKAGE_PSEC_${mode}`, mode: mode === 'plan' ? 'plan' : 'default' },
          mutation(),
        )
        const snapshot = await until(
          async () => {
            const state = await client!.sessions.snapshot(ref)
            return !state.state.isStreaming &&
              state.messages.some((m) => m.role === 'toolResult' && m.toolName === 'powershell')
              ? state
              : undefined
          },
          () => logs,
        )
        assert.equal(snapshot.connection.restrictedAccessSupported, true, snapshot.connection.restrictedAccessReason)
        const result = snapshot.messages.find((m) => m.role === 'toolResult' && m.toolName === 'powershell')!
        assert.equal(result.role === 'toolResult' && result.isError, false, JSON.stringify(result))
        assert.ok(result.role === 'toolResult')
        const text = result.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('')
        assert.deepEqual(JSON.parse(text.trim()), { workspace: mode === 'workspace-write', outside: false })
        assert.equal(await readFile(outside, 'utf8'), 'original')
      }
      const plugin = path.join(root, '受限 插件')
      await mkdir(path.join(plugin, 'dist'), { recursive: true })
      await writeFile(
        path.join(plugin, 'package.json'),
        JSON.stringify({
          name: 'windows-package-probe',
          version: '1.0.0',
          type: 'module',
          piMeme: {
            sdkVersion: 3,
            agent: { restricted: 'dist/agent.js' },
            server: { restricted: 'dist/server.js' },
            permissions: { restricted: { maxAccess: 'read-only', capabilities: ['workspace.read'] } },
          },
        }),
      )
      await writeFile(
        path.join(plugin, 'dist/agent.js'),
        `import fs from 'node:fs';export function activate(ctx){ctx.tools.register({name:'package_probe',title:'包内检查',description:'检查隔离',parameters:{type:'object'},effect:'read',capabilities:['workspace.read'],execute:async()=>{let denied=false;try{fs.writeFileSync('plugin-forbidden','bad')}catch{denied=true}let secret=false;try{fs.readFileSync(${JSON.stringify(path.join(dataRoot, storageLayoutRelativePaths.authFile))})}catch{secret=true}return {text:JSON.stringify({denied,secret,server:await ctx.server.call('ping',{})})}}})}`,
      )
      await writeFile(
        path.join(plugin, 'dist/server.js'),
        `export function create(ctx){ctx.registerOperations([{name:'ping',inputSchema:{type:'object'},outputSchema:{type:'string'},audience:['agent'],effect:'read',capabilities:['workspace.read'],execute:()=> 'PACKAGE_PLUGIN_SERVER'}])}`,
      )
      const installed = await client.rpc<{ id: string; grant: PluginGrant; policyHash: string }>(
        'plugins:install-directory',
        [plugin],
      )
      await client.rpc('plugins:set-grant', [
        installed.id,
        {
          ...installed.grant,
          expectedRevision: installed.grant.revision,
          policyHash: installed.policyHash,
          restricted: { maxAccess: 'read-only', capabilities: ['workspace.read'] },
        },
      ])
      const restricted = await client.sessions.create(
        {
          project,
          configuration: {
            model: { provider: 'fake', id: 'first' },
            accessMode: 'read-only',
            agentPlugins: [installed.id],
            mode: 'plan',
          },
        },
        mutation(),
      )
      await client.sessions.submit(
        restricted,
        { delivery: 'start', text: 'PACKAGE_RESTRICTED', mode: 'plan' },
        mutation(),
      )
      const checked = await until(
        async () => {
          const state = await client!.sessions.snapshot(restricted)
          return !state.state.isStreaming &&
            state.messages.some((m) => m.role === 'toolResult' && m.toolName === 'package_probe')
            ? state
            : undefined
        },
        () => logs,
      )
      const result = checked.messages.find((m) => m.role === 'toolResult' && m.toolName === 'package_probe')!
      assert.equal(result.role === 'toolResult' && result.isError, false, JSON.stringify(result))
      assert.ok(result.role === 'toolResult')
      const text = result.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('')
      assert.deepEqual(JSON.parse(text), { denied: true, secret: true, server: 'PACKAGE_PLUGIN_SERVER' })
      await client.rpc('plugins:disable', [installed.id])
      await client.rpc('plugins:remove', [installed.id])
    } finally {
      client?.dispose()
      if (child) {
        child.kill()
        await child.completion
      }
      await fake.dispose()
      await rm(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 })
    }
  },
)
