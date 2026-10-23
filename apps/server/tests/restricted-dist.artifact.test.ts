import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import type { Snapshot, SessionSelectionResult } from '@pi-meme/contracts/desktop'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'
import { serverArtifact } from '../../../tests/fixtures/server-artifact'
import { storageLayoutRelativePaths } from '@pi-meme/contracts/storage-paths'

test(
  'Server 产物默认工作区权限执行 bash/write/edit，拒绝越界；仅可查看和恢复保留权限',
  { timeout: 60000 },
  async (t) => {
    if (!['darwin', 'linux'].includes(process.platform)) return t.skip('当前平台没有受支持的沙箱后端')
    const repo = fileURLToPath(new URL('../../../', import.meta.url))
    const root = await mkdtemp(path.join(tmpdir(), 'server-restricted-'))
    const project = path.join(root, 'project')
    const outside = path.join(root, 'outside')
    await Promise.all([mkdir(project), mkdir(outside)])
    const targets = { inside: path.join(project, 'inside.txt'), outside: path.join(outside, 'original') }
    await writeFile(targets.outside, 'original')
    await symlink(outside, path.join(project, 'escape'))
    const artifact = await serverArtifact(repo, root, path.join(root, 'userData'))
    let call: { name: string; arguments: string } | undefined
    let issued = false
    const fake = await useFakeAgent(root, {
      reply: () => {
        if (call && !issued) {
          issued = true
          return { tool: call }
        }
        return 'RESTRICTED-DONE'
      },
    })
    const data = fake.runtimePaths.dataRoot
    await mkdir(path.join(data, storageLayoutRelativePaths.credentialsDirectory), { recursive: true })
    await writeFile(
      path.join(data, storageLayoutRelativePaths.credentialsDirectory, 'test-credentials.json'),
      JSON.stringify(Object.fromEntries(fake.credentials.entries())),
    )
    // 不写 defaultAccessMode，也不调用完全权限切换。
    let output = ''
    const start = () => {
      output = ''
      const process = spawn(artifact.command, artifact.args, {
        cwd: artifact.cwd,
        env: artifact.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      process.stdout.on('data', (chunk) => {
        output += chunk.toString()
      })
      process.stderr.on('data', (chunk) => {
        output += chunk.toString()
      })
      return process
    }
    let child = start()
    let closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
    let cookie = ''
    let url = ''
    const connect = async () => {
      for (let count = 0; count < 400; count++) {
        const match = /Host 已启动：(http:\/\/[^；\s]+)/.exec(output)
        if (match) {
          url = match[1]!
          break
        }
        if (child.exitCode !== null) throw new Error(output)
        await delay(25)
      }
      assert.ok(url, output)
      const response = await fetch(`${url}/api/auth`, { method: 'POST', headers: { Origin: url }, body: '{}' })
      assert.equal(response.status, 200)
      cookie = response.headers.get('set-cookie')!.split(';')[0]!
    }
    const rpc = async <T>(method: string, args: unknown[] = [], sessionId?: string): Promise<T> => {
      const response = await fetch(`${url}/api/rpc`, {
        method: 'POST',
        headers: { Cookie: cookie, Origin: url },
        body: JSON.stringify({ requestId: crypto.randomUUID(), clientId: 'restricted', method, args, sessionId }),
      })
      const body = (await response.json()) as { result: T; error?: unknown }
      assert.equal(body.error, undefined, JSON.stringify(body.error))
      return body.result
    }
    const stop = async (verify = false) => {
      child.kill('SIGTERM')
      await Promise.race([closed, delay(5000, undefined, { ref: false })])
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await closed
      }
      if (verify) assert.equal(child.exitCode, 0, `Host 必须在 SIGTERM 后正常退出：${output}`)
    }
    try {
      await connect()
      const selected = await rpc<SessionSelectionResult>('workspace:select', [{ kind: 'project', cwd: project }])
      assert.ok(!selected.cancelled)
      let snapshot = selected.snapshot
      assert.equal(snapshot.connection.accessMode, 'workspace-write')
      assert.equal(snapshot.connection.restrictedAccessSupported, true, snapshot.connection.restrictedAccessReason)
      const key = snapshot.connection.sessionKey!
      await rpc('pi:set-model', [key, { provider: 'fake', id: 'first' }], key)
      const execute = async (name: string, args: object, error: boolean) => {
        call = { name, arguments: JSON.stringify(args) }
        issued = false
        const previous = snapshot.messages.length
        await rpc('pi:prompt', [key, `验收 ${name}`], key)
        for (let count = 0; count < 400; count++) {
          snapshot = await rpc<Snapshot>('pi:snapshot', [], key)
          if (
            !snapshot.state.isStreaming &&
            snapshot.messages.slice(previous).some((message) => message.role === 'toolResult')
          )
            break
          await delay(25)
        }
        const result = snapshot.messages.slice(previous).find((message) => message.role === 'toolResult')
        assert.ok(result?.role === 'toolResult', JSON.stringify(snapshot))
        assert.equal(result.isError, error, JSON.stringify(result))
      }
      await execute('write', { path: targets.inside, content: 'first' }, false)
      await execute('edit', { path: targets.inside, oldText: 'first', newText: 'edited' }, false)
      await execute('bash', { command: 'echo bash > bash.txt' }, false)
      await execute('bash', { command: `echo forbidden > ${JSON.stringify(targets.outside)}` }, true)
      await execute('write', { path: targets.outside, content: 'forbidden' }, true)
      await execute(
        'edit',
        { path: path.join(project, 'escape/original'), oldText: 'original', newText: 'forbidden' },
        true,
      )
      assert.equal(await readFile(targets.inside, 'utf8'), 'edited')
      assert.equal(await readFile(path.join(project, 'bash.txt'), 'utf8'), 'bash\n')
      assert.equal(await readFile(targets.outside, 'utf8'), 'original')
      await rpc('pi:access-mode', [key, 'read-only'], key)
      await execute('read', { path: targets.inside }, false)
      await execute('bash', { command: 'echo forbidden > inside.txt' }, true)
      await execute('write', { path: targets.inside, content: 'forbidden' }, true)
      await execute('edit', { path: targets.inside, oldText: 'edited', newText: 'forbidden' }, true)
      const sessionFile = snapshot.connection.sessionFile!
      assert.equal(await readFile(targets.inside, 'utf8'), 'edited')
      await stop(true)
      child = start()
      closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
      url = ''
      await connect()
      const restored = await rpc<SessionSelectionResult>('pi:switch-session', [sessionFile])
      assert.ok(!restored.cancelled)
      assert.equal(restored.snapshot.connection.accessMode, 'read-only')
    } finally {
      await stop()
      await fake.dispose()
      await rm(root, { recursive: true, force: true })
    }
  },
)
