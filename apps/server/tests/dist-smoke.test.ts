import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { openSync, closeSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'
import type { InstructionsSnapshot, SaveInstructionResult } from '@pi-meme/contracts/settings'
import { requestText } from '../../../tests/fixtures/fake-provider.mjs'

type Snapshot = {
  connection: { sessionKey?: string; sessionFile?: string }
  models: Array<{ id: string }>
  state: { isStreaming: boolean }
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
    let child: ChildProcess | undefined
    let closed: Promise<void> | undefined
    let stdout = ''
    const agent = await useFakeAgent(root, {
      reply(body: { tools?: Array<{ function?: { name?: string } }> }) {
        const tools = (body.tools ?? []).flatMap((tool) => (tool.function?.name ? [tool.function.name] : []))
        seen.push({ mode, tools })
        const wanted =
          mode === 'external'
            ? 'dist_probe'
            : mode === 'mcp'
              ? tools.find((name) => name.includes('echo'))
              : mode === 'subagent'
                ? 'Task'
                : mode.startsWith('codemode')
                  ? 'codemode'
                  : undefined
        if (wanted && tools.includes(wanted) && !issued.has(mode)) {
          issued.add(mode)
          const args =
            mode === 'external'
              ? {}
              : mode === 'mcp'
                ? { text: 'DIST-MCP' }
                : mode === 'subagent'
                  ? { agent: 'explorer', task: '读取临时项目概况', description: '产物验证' }
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
      await writeFile(
        path.join(data, 'test-credentials.json'),
        JSON.stringify(Object.fromEntries(agent.credentials.entries())),
      )
      await writeFile(
        path.join(data, 'settings.json'),
        JSON.stringify({
          themeId: 'dark',
          defaultAccessMode: 'full-access',
          mcpEnabled: true,
          codemodeEnabled: true,
          subagentsEnabled: true,
          enabledSubagents: ['explorer'],
        }),
      )
      await mkdir(path.join(data, 'pi/subagents'), { recursive: true })
      await writeFile(
        path.join(data, 'pi/subagents/explorer.md'),
        '---\nname: explorer\ndescription: 检查临时目录\n---\n读取临时目录并报告。',
      )
      await writeFile(
        path.join(data, 'pi/mcp.json'),
        JSON.stringify({
          mcpServers: {
            fixture: {
              command: process.execPath,
              args: [path.join(repo, 'tests/fixtures/mcp-server.mjs'), '--stdio'],
              exposure: 'direct',
              env: { MCP_FIXTURE_LOG: path.join(root, 'mcp.log') },
            },
          },
        }),
      )
      child = spawn(process.execPath, [path.join(repo, 'apps/server/dist/main.js')], {
        cwd: repo,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          PI_MEME_DATA_ROOT: data,
          PI_MEME_TEST_CREDENTIALS: 'memory',
          PI_MEME_PORT: '0',
          PI_MEME_TOKEN: 'dist-smoke-token',
        },
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
        assert.equal(body.error, undefined, `${method}：${JSON.stringify(body.error)}`)
        return body.result
      }
      assert.equal((await rpc<unknown[]>('plugins:list')).length, 14)
      await rpc('workspace:select', [{ kind: 'project', cwd: project }])
      const initial = await rpc<Snapshot>('pi:snapshot')
      const key = initial.connection.sessionKey!
      assert.ok(initial.models.some((model) => model.id === 'first'))
      const plugin = path.join(root, 'plugin')
      await mkdir(path.join(plugin, 'dist/agent'), { recursive: true })
      await writeFile(
        path.join(plugin, 'package.json'),
        JSON.stringify({
          name: 'dist-agent-probe',
          version: '1.0.0',
          piMeme: { sdkVersion: 1, agent: 'dist/agent/entry.js' },
        }),
      )
      await writeFile(
        path.join(plugin, 'dist/agent/entry.js'),
        `export default function(pi) {
      pi.registerTool({ name: 'dist_probe', label: '产物工具', description: '验证外部工具',
        parameters: { type: 'object', properties: {} },
        async execute() { return { content: [{ type: 'text', text: 'DIST-EXTERNAL' }], details: {} } }
      })
    }`,
      )
      await rpc('plugins:install-directory', [plugin])
      for (const step of ['base', 'external', 'mcp', 'subagent', 'codemode', 'codemode-only']) {
        mode = step
        if (step === 'codemode-only') {
          const current = await rpc<Settings>('settings:get')
          await rpc('settings:save', [{ ...current.settings, mcpEnabled: false, codemodeEnabled: true }])
        }
        await rpc('pi:prompt', [key, `产物验证 ${step}`], key)
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
              : step === 'subagent'
                ? 'DIST-subagent-OK'
                : step.startsWith('codemode')
                  ? '42'
                  : undefined
        if (expected)
          assert.ok(
            snapshot!.messages.some(
              (message) => message.role === 'toolResult' && JSON.stringify(message).includes(expected),
            ),
          )
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
