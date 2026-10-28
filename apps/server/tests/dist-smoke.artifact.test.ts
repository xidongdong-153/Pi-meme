import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { openSync, closeSync } from 'node:fs'
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { finishAgentReply, useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'
import { createDevkitAppPackage } from '../../../tests/fixtures/devkit-app'
import { serverArtifact } from '../../../tests/fixtures/server-artifact'
import type { AgentSummary } from '@pi-meme/contracts/collaboration'
import type { PlanDocument } from '@pi-meme/contracts/plan'
import type { InstructionsSnapshot, SaveInstructionResult } from '@pi-meme/contracts/settings'
import type { PiSlashCommand } from '@pi-meme/contracts/pi'
import { requestText } from '../../../tests/fixtures/fake-provider.mjs'
import { storageLayoutRelativePaths as storagePaths } from '@pi-meme/contracts/storage-paths'
import type { UiPluginDescriptor } from '@pi-meme/plugin-sdk/ui'

type Snapshot = {
  connection: { sessionKey?: string; sessionFile?: string }
  models: Array<{ id: string }>
  state: { isStreaming: boolean; mode: 'default' | 'plan' }
  agents?: AgentSummary[]
  planDocuments?: PlanDocument[]
  messages: Array<{ role: string; [key: string]: unknown }>
}
type Settings = { settings: Record<string, unknown> }

test(
  '独立 Server 产物启动 Worker，执行原生会话、外部工具、MCP、SubAgent 和 codemode',
  {
    timeout: 180_000,
  },
  async () => {
    const repo = fileURLToPath(new URL('../../../', import.meta.url))
    const root = await mkdtemp(path.join(tmpdir(), 'pi-meme-server-dist-'))
    const stderrPath = path.join(root, 'host-stderr.log')
    const stderrFd = openSync(stderrPath, 'w')
    let mode = 'base'
    const issued = new Set<string>()
    const seen: Array<{ mode: string; tools: string[] }> = []
    let collaborationStep = 0
    let spawned: AgentSummary | undefined
    let continued: AgentSummary | undefined
    const childReports: string[] = []
    const collaborationTrace: Array<{ step: number; prompt: string; result: unknown }> = []
    let child: ChildProcess | undefined
    let closed: Promise<void> | undefined
    let stdout = ''
    const agent = await useFakeAgent(root, {
      reply(body: {
        tools?: Array<{ function?: { name?: string } }>
        messages?: Array<{ role: string; content: unknown }>
      }) {
        const tools = (body.tools ?? []).flatMap((tool) => (tool.function?.name ? [tool.function.name] : []))
        seen.push({ mode, tools })
        const user = [...(body.messages ?? [])]
          .reverse()
          .find(
            (message) =>
              message.role === 'user' &&
              !JSON.stringify(message.content).includes('当前访问权限：') &&
              !JSON.stringify(message.content).includes('当前是规划模式') &&
              !JSON.stringify(message.content).includes('子 Agent 已返回结果，请结合已保存的协作消息') &&
              !JSON.stringify(message.content).includes('[来自 '),
          )
        const prompt = JSON.stringify(user?.content)
        const result = (body.messages ?? []).at(-1)
        const toolResult =
          mode === 'subagent' &&
          !prompt.includes('DIST-CHILD-') &&
          result?.role === 'tool' &&
          typeof result.content === 'string'
            ? (JSON.parse(result.content) as Record<string, unknown>)
            : undefined
        const invoke = (name: string, args: object) => ({
          tool: { id: `dist-${name}-${collaborationStep}`, name, arguments: JSON.stringify(args) },
        })
        if (mode === 'subagent') {
          collaborationTrace.push({ step: collaborationStep, prompt, result: toolResult })
          if (prompt.includes('DIST-CHILD-FOLLOWUP')) return finishAgentReply(body, 'DIST-CHILD-FOLLOWUP-OK')
          if (prompt.includes('DIST-CHILD-FIRST')) return finishAgentReply(body, 'DIST-CHILD-FIRST-OK')
          if (spawned) {
            const prefix = `[来自 ${spawned.agentId}] `
            for (const message of body.messages ?? []) {
              if (message.role !== 'user') continue
              const text = requestText({ messages: [message] })
              if (text.startsWith(prefix)) childReports.push(text.slice(prefix.length))
            }
          }
          if (collaborationStep === 0) {
            issued.add(mode)
            collaborationStep = 1
            return invoke('spawn_agent', {
              task_name: 'explorer',
              message: 'DIST-CHILD-FIRST：读取临时项目概况',
              fork_turns: 'none',
            })
          }
          if (collaborationStep === 1) {
            spawned = toolResult as AgentSummary | undefined
            collaborationStep = 2
            return invoke('wait_agent', { targets: [spawned?.agentId], timeout_ms: 5000 })
          }
          const agents = toolResult?.agents as AgentSummary[] | undefined
          if (
            collaborationStep === 2 &&
            agents?.some((entry) => entry.agentId === spawned?.agentId && entry.status === 'completed')
          ) {
            childReports.push(
              ...((toolResult?.messages as Array<{ text: string }>) ?? []).map((message) => message.text),
            )
            collaborationStep = 3
            return invoke('followup_task', {
              target: spawned!.agentId,
              message: 'DIST-CHILD-FOLLOWUP：继续检查临时项目',
            })
          }
          if (collaborationStep === 3) {
            continued = toolResult?.agent as AgentSummary | undefined
            collaborationStep = 4
            return invoke('wait_agent', { targets: [spawned?.agentId], timeout_ms: 5000 })
          }
          if (
            collaborationStep === 4 &&
            agents?.some((entry) => entry.agentId === spawned?.agentId && entry.status === 'completed')
          ) {
            childReports.push(
              ...((toolResult?.messages as Array<{ text: string }>) ?? []).map((message) => message.text),
            )
            return { text: 'DIST-subagent-OK' }
          }
          return invoke('wait_agent', { targets: [spawned?.agentId], timeout_ms: 5000 })
        }
        if (mode === 'plan' && !issued.has(mode)) {
          issued.add(mode)
          return invoke('save_plan', {
            title: 'Server 产物计划',
            markdown: '# Server 产物计划\n\n1. 读取临时项目。\n2. 运行验证命令。\n',
          })
        }
        const wanted = mode.startsWith('devkit')
          ? 'dist_devkit_app_time'
          : mode === 'external'
            ? 'dist_probe'
            : mode === 'mcp'
              ? tools.find((name) => name.includes('echo'))
              : mode.startsWith('codemode')
                ? 'codemode'
                : undefined
        if (wanted && tools.includes(wanted) && !issued.has(mode)) {
          issued.add(mode)
          const args =
            mode === 'external' || mode.startsWith('devkit')
              ? {}
              : mode === 'mcp'
                ? { text: 'DIST-MCP' }
                : { code: 'text(40 + 2)' }
          return { tool: { name: wanted, arguments: JSON.stringify(args) } }
        }
        return { text: `DIST-${mode}-OK` }
      },
    })
    const data = path.join(root, 'userData')
    try {
      const project = path.join(root, 'project')
      await mkdir(project)
      const artifact = await serverArtifact(repo, root, data)
      const mcpServer = path.join(root, 'mcp-server.mjs')
      await copyFile(path.join(repo, 'tests/fixtures/mcp-server.mjs'), mcpServer)
      await mkdir(path.join(data, storagePaths.credentialsDirectory), { recursive: true })
      await writeFile(
        path.join(data, storagePaths.credentialsDirectory, 'test-credentials.json'),
        JSON.stringify(Object.fromEntries(agent.credentials.entries())),
      )
      await writeFile(
        path.join(data, storagePaths.appConfigFile),
        JSON.stringify({
          themeId: 'dark',
          defaultAccessMode: 'full-access',
          mcpEnabled: true,
          subagentsEnabled: false,
          enabledSubagents: [],
        }),
      )
      await writeFile(
        path.join(data, storagePaths.agentMcpFile),
        JSON.stringify({
          mcpServers: {
            fixture: {
              command: artifact.node,
              args: [mcpServer, '--stdio'],
              exposure: 'direct',
              env: { MCP_FIXTURE_LOG: path.join(root, 'mcp.log') },
            },
          },
        }),
      )
      child = spawn(artifact.command, artifact.args, {
        cwd: artifact.cwd,
        env: { ...artifact.env, PI_MEME_TOKEN: 'dist-smoke-token' },
        stdio: ['ignore', 'pipe', stderrFd],
      })
      closed = new Promise((resolve) => child!.once('close', () => resolve()))
      child.stdout!.on('data', (buffer: Buffer) => {
        stdout += buffer.toString()
      })
      let url: string | undefined
      for (let count = 0; count < 2400; count++) {
        const match = /Host 已启动：(http:\/\/[^；\s]+)/.exec(stdout)
        if (match) {
          url = match[1]
          break
        }
        if (child.exitCode !== null) {
          await closed
          throw new Error(
            (await readFile(stderrPath, 'utf8'))
              .split('\n')
              .filter((line) => line.length < 1000)
              .join('\n'),
          )
        }
        await delay(25)
      }
      assert.ok(url, `Host 产物未在 60 秒内启动：${stdout}`)
      if (artifact.bundled) {
        const page = await fetch(url)
        assert.equal(page.status, 200, '独立包提供 Web 首页')
        const html = await page.text()
        const script = /<script[^>]+src="([^"]+)"/.exec(html)?.[1]
        assert.ok(script, '首页引用构建后的脚本')
        const resource = await fetch(new URL(script, url))
        assert.equal(resource.status, 200, '独立包提供 Web 脚本')
        assert.match(resource.headers.get('content-type') ?? '', /javascript/)
        await resource.body?.cancel()
        const rejected = await fetch(`${url}/api/rpc`, { method: 'POST', body: '{}' })
        assert.equal(rejected.status, 401, '未认证请求不能调用 Host')
      }
      const auth = await fetch(`${url}/api/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'dist-smoke-token' }),
      })
      assert.equal(auth.status, 200)
      const cookie = auth.headers.get('set-cookie')!.split(';')[0]
      let hostId: string | undefined
      async function rpc<T>(method: string, args: unknown[] = [], sessionId?: string): Promise<T> {
        const response = await fetch(`${url}/api/rpc`, {
          method: 'POST',
          headers: { Cookie: cookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId: crypto.randomUUID(), clientId: 'dist', hostId, sessionId, method, args }),
        })
        const body = (await response.json()) as { hostId: string; result: T; error?: { message: string } }
        hostId = body.hostId
        assert.equal(body.error, undefined, `${method}（${mode}）：${JSON.stringify(body.error)}`)
        return body.result
      }
      assert.deepEqual(
        (await rpc<Array<{ builtin?: boolean }>>('plugins:list')).filter((plugin) => !plugin.builtin),
        [],
      )
      const skillSource = path.join(repo, 'pi/skills/skill-creator')
      const skillInstalled = path.join(data, storagePaths.builtinSkillsDirectory, 'skill-creator')
      for (const entry of await readdir(skillSource, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue
        const relative = path.relative(skillSource, path.join(entry.parentPath, entry.name))
        assert.deepEqual(
          await readFile(path.join(skillInstalled, relative)),
          await readFile(path.join(skillSource, relative)),
          `Server 产物完整分发内置 Skill Creator：${relative}`,
        )
      }
      await rpc('workspace:select', [{ kind: 'project', cwd: project }])
      const initial = await rpc<Snapshot>('pi:snapshot')
      const key = initial.connection.sessionKey!
      assert.ok(initial.models.some((model) => model.id === 'first'))
      const creator = (await rpc<PiSlashCommand[]>('pi:commands')).find(
        (command) => command.name === 'skill:skill-creator',
      )
      assert.ok(creator, 'Server Worker 加载内置 Skill Creator')
      assert.equal(creator.builtin, true)
      assert.equal(creator.displayName, 'Skill Creator')
      assert.ok(creator.sourceInfo.path.startsWith(path.join(data, storagePaths.snapshotsDirectory)))
      assert.ok(creator.resourceId && creator.resourceRevision)
      const appPackage = await createDevkitAppPackage(root, 'dist-devkit-app')
      const installedApp = await rpc<UiPluginDescriptor>('plugins:install-package', [appPackage])
      assert.equal(installedApp.status, 'active')
      assert.deepEqual(installedApp.grant?.trusted, { ui: false, server: false, agent: false })
      const plugin = path.join(root, 'plugin')
      await mkdir(path.join(plugin, 'dist/agent'), { recursive: true })
      await writeFile(
        path.join(plugin, 'package.json'),
        JSON.stringify({
          name: 'dist-agent-probe',
          version: '1.0.0',
          piMeme: {
            sdkVersion: 3,
            agent: { trusted: 'dist/agent/entry.js', restricted: 'dist/agent/restricted.js' },
            permissions: { restricted: { maxAccess: 'read-only', capabilities: [] } },
          },
        }),
      )
      await writeFile(
        path.join(plugin, 'dist/agent/entry.js'),
        `export function activate(context) {
      context.tools.register({ name: 'dist_probe', title: '产物工具', description: '验证外部工具',
        parameters: { type: 'object', properties: {} },
        async execute() { return { text: 'DIST-EXTERNAL' } }
      })
    }`,
      )
      await writeFile(path.join(plugin, 'dist/agent/restricted.js'), 'export function activate() {}')
      const installedProbe = await rpc<UiPluginDescriptor>('plugins:install-directory', [plugin])
      assert.equal(installedProbe.grant?.trusted.agent, false, '安装不能自动信任 Agent')
      assert.ok(installedProbe.grant && installedProbe.policyHash)
      await rpc('plugins:set-grant', [
        installedProbe.id,
        {
          ...installedProbe.grant,
          expectedRevision: installedProbe.grant.revision,
          policyHash: installedProbe.policyHash,
          trusted: { ui: false, server: false, agent: true },
        },
      ])
      await rpc('pi:set-model', [key, { provider: 'fake', id: 'first' }], key)
      const ref = await rpc('host:session-ref', [key], key)
      const configured = await fetch(`${url}/api/control`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiVersion: 2,
          clientId: 'dist',
          method: 'sessions.configure',
          args: [ref, { agentPlugins: [installedApp.id, installedProbe.id] }],
          idempotencyKey: crypto.randomUUID(),
        }),
      })
      assert.equal(((await configured.json()) as { error?: unknown }).error, undefined)
      async function control<T>(method: string, args: unknown[]): Promise<T> {
        const response = await fetch(`${url}/api/control`, {
          method: 'POST',
          headers: { Cookie: cookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            apiVersion: 2,
            hostId,
            clientId: 'dist',
            method,
            args,
            idempotencyKey: crypto.randomUUID(),
          }),
        })
        const result = (await response.json()) as { result: T; error?: unknown }
        assert.equal(result.error, undefined)
        return result.result
      }
      const capabilities = await control<{ features: string[] }>('capabilities', [])
      if (artifact.bundled || process.platform === 'darwin')
        assert.ok(capabilities.features.includes('terminal'), 'Server 产物包含可加载的 PTY 原生模块')
      if (capabilities.features.includes('terminal')) {
        const terminal = await control<{ hostId: string; terminalId: string }>('terminal.open', [
          ref,
          { command: '/bin/sh' },
        ])
        await control('terminal.input', [terminal, "printf 'PTY-DIST-%s\\n' OK\nexit\n"])
        let output = ''
        for (let count = 0; count < 100; count++) {
          const state = await control<{ output: string; exited: boolean }>('terminal.attach', [terminal])
          output = state.output
          if (state.exited) break
          await delay(25)
        }
        assert.ok(output.includes('PTY-DIST-OK'), output)
        await control('terminal.close', [terminal])
      }

      for (const step of [
        'base',
        'devkit',
        'devkit-reloaded',
        'external',
        'mcp',
        'subagent',
        'codemode',
        'codemode-only',
        'plan',
      ]) {
        mode = step
        if (step === 'devkit-reloaded') {
          const reloaded = await rpc<UiPluginDescriptor>('plugins:reload', [installedApp.id])
          assert.equal(reloaded.status, 'active')
          assert.ok(reloaded.generation > installedApp.generation)
          assert.deepEqual(reloaded.grant?.trusted, { ui: false, server: false, agent: false })
        }
        if (step === 'codemode-only') {
          const current = await rpc<Settings>('settings:get')
          await rpc('settings:save', [{ ...current.settings, mcpEnabled: false, codemodeEnabled: false }])
        }
        await rpc('pi:prompt', [key, `${step === 'plan' ? '/plan ' : ''}产物验证 ${step}`], key)
        let snapshot: Snapshot | undefined
        const replied = () =>
          snapshot?.messages.some(
            (message) => message.role === 'assistant' && JSON.stringify(message).includes(`DIST-${step}-OK`),
          )
        for (let count = 0; count < 600; count++) {
          snapshot = await rpc<Snapshot>('pi:snapshot')
          if (!snapshot.state.isStreaming && replied()) break
          await delay(25)
        }
        assert.ok(replied(), `${step} 没有回复：${JSON.stringify(snapshot)}`)
        if (step !== 'base') assert.ok(issued.has(step), `${step} 工具未激活：${JSON.stringify(seen)}`)
        const expected =
          step === 'external'
            ? 'DIST-EXTERNAL'
            : step === 'mcp'
              ? 'MCP:DIST-MCP'
              : step.startsWith('codemode')
                ? '42'
                : undefined
        if (expected)
          assert.ok(
            snapshot!.messages.some(
              (message) => message.role === 'toolResult' && JSON.stringify(message).includes(expected),
            ),
          )
        if (step.startsWith('devkit')) {
          const time = snapshot!.messages.findLast(
            (message) => message.role === 'toolResult' && message.toolName === 'dist_devkit_app_time',
          )
          assert.ok(time && time.isError === false, JSON.stringify(time))
          assert.match(JSON.stringify(time.content), /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
        }
        if (step === 'subagent') {
          assert.ok(spawned?.agentId && spawned.sessionFile)
          assert.equal(continued?.agentId, spawned.agentId)
          assert.equal(continued?.sessionFile, spawned.sessionFile)
          assert.notEqual(continued?.runId, spawned.runId)
          assert.ok(childReports.some((text) => text.includes('DIST-CHILD-FIRST-OK')))
          assert.ok(
            childReports.some((text) => text.includes('DIST-CHILD-FOLLOWUP-OK')),
            JSON.stringify({ childReports, collaborationTrace, agents: snapshot?.agents }),
          )
          const childSnapshot = await rpc<Snapshot>('pi:agent-snapshot', [spawned.agentId])
          assert.ok(JSON.stringify(childSnapshot.messages).includes('DIST-CHILD-FIRST-OK'))
          assert.ok(JSON.stringify(childSnapshot.messages).includes('DIST-CHILD-FOLLOWUP-OK'))
          assert.equal((await rpc<Snapshot>('pi:snapshot')).connection.sessionKey, key)
        }
        if (step === 'plan') {
          assert.equal(snapshot!.state.mode, 'plan')
          const document = snapshot!.planDocuments?.find((entry) => entry.title === 'Server 产物计划')
          assert.ok(document)
          assert.equal(
            await readFile(
              path.join(data, storagePaths.plansDataDirectory, document.sessionId, `${document.id}.md`),
              'utf8',
            ),
            document.markdown,
          )
          const planRequests = seen.filter((request) => request.mode === step)
          assert.ok(planRequests.length > 0, '规划模式必须发送模型请求')
          for (const request of planRequests) {
            const tools = request.tools
            assert.ok(
              tools.includes('bash') && tools.includes('codemode'),
              `规划调研工具缺失：${JSON.stringify(tools)}`,
            )
            assert.ok(
              !tools.some((name) => ['write', 'edit', 'dist_probe'].includes(name) || name.startsWith('mcp__')),
              `规划模式包含不可用工具：${JSON.stringify(tools)}`,
            )
          }
        }
        if (step === 'codemode-only')
          assert.ok(
            seen
              .filter((request) => request.mode === step)
              .every((request) => !request.tools.some((name) => name.startsWith('mcp__'))),
          )
      }
      assert.match(await readFile(path.join(root, 'mcp.log'), 'utf8'), /tools\/call/)
      assert.ok((await rpc<Snapshot>('pi:snapshot')).connection.sessionFile)
      assert.ok(await rpc('settings:usage-stats'))
      const beforeInstructions = await rpc<Snapshot>('pi:snapshot')
      const instructions = await rpc<InstructionsSnapshot>('settings:instructions')
      const agents = instructions.entries.find((entry) => entry.kind === 'agents')!
      const saved = await rpc<SaveInstructionResult>('settings:save-instruction', [
        { kind: 'agents', content: 'DIST-HOST-INSTRUCTIONS', revision: agents.host.revision },
      ])
      assert.equal(saved.reloadError, undefined)
      mode = 'instructions'
      await rpc('pi:prompt', [key, '指令重载验证'], key)
      let afterInstructions = await rpc<Snapshot>('pi:snapshot')
      for (let count = 0; count < 600; count++) {
        afterInstructions = await rpc<Snapshot>('pi:snapshot')
        if (
          !afterInstructions.state.isStreaming &&
          JSON.stringify(afterInstructions.messages).includes('DIST-instructions-OK')
        )
          break
        await delay(25)
      }
      assert.equal(afterInstructions.connection.sessionKey, beforeInstructions.connection.sessionKey)
      assert.equal(afterInstructions.connection.sessionFile, beforeInstructions.connection.sessionFile)
      assert.ok(JSON.stringify(afterInstructions.messages).includes('DIST-base-OK'))
      assert.match(requestText(agent.provider.requests.at(-1)), /DIST-HOST-INSTRUCTIONS/)
      child.kill('SIGTERM')
      await Promise.race([closed, delay(10_000, undefined, { ref: false })])
      assert.equal(child.exitCode, 0, `Host 必须在 SIGTERM 后正常退出：${await readFile(stderrPath, 'utf8')}`)
      assert.equal(child.signalCode, null)
    } finally {
      if (child && child.exitCode === null) {
        child.kill('SIGTERM')
        await Promise.race([closed, delay(10_000, undefined, { ref: false })])
        if (child.exitCode === null) {
          child.kill('SIGKILL')
          await closed
        }
      }
      closeSync(stderrFd)
      await agent.dispose()
      await rm(root, { recursive: true, force: true })
    }
  },
)
