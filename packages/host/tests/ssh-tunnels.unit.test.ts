import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess, spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'
import type { SshConnection } from '@pi-meme/contracts/ssh-connections'
import { createSshTunnelStarter } from '../src/ssh-tunnels'

const connection: SshConnection = {
  id: 'a'.repeat(24),
  name: '测试',
  target: 'work',
  hostPort: 31415,
  enabled: true,
  hasToken: true,
  phase: 'connecting',
}
let root: string
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'pi-ssh-identity-'))
  connection.identityFile = path.join(root, 'identity path')
  await writeFile(connection.identityFile, '测试用占位文件，不包含密钥', { mode: 0o600 })
})
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})

function fakeProcesses(configOutput: string, hangConfig = false) {
  const calls: string[][] = []
  const children: ChildProcess[] = []
  const run = ((_executable: string, args: string[], options: { shell: boolean; detached: boolean }) => {
    assert.equal(options.shell, false)
    assert.equal(options.detached, true)
    calls.push(args)
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null,
      pid: 100 + children.length,
      kill() {
        child.exitCode = 0
        queueMicrotask(() => child.emit('close', 0))
        return true
      },
    })
    children.push(child as unknown as ChildProcess)
    if (args.includes('-G') && !hangConfig)
      queueMicrotask(() => {
        child.stdout.write(configOutput)
        child.exitCode = 0
        child.emit('close', 0)
      })
    return child
  }) as unknown as typeof spawn
  const signalGroup = (pid: number, signal: NodeJS.Signals | 0) => {
    const child = children.find((item) => item.pid === pid)
    if (!child || child.exitCode !== null) return false
    if (signal !== 0) child.kill(signal)
    return true
  }
  return { calls, children, run, signalGroup }
}

test('SSH 隧道仅使用参数数组、受管前台进程与 loopback，取消后停止进程', async () => {
  const fake = fakeProcesses('hostname work.example\n')
  const start = createSshTunnelStarter({
    spawn: fake.run,
    signalGroup: fake.signalGroup,
    executable: async () => '/usr/bin/ssh',
    allocatePort: async () => 45231,
    ready: async () => true,
  })
  const controller = new AbortController()
  const tunnel = await start(connection, controller.signal)
  assert.equal(tunnel.endpoint, 'http://127.0.0.1:45231')
  assert.equal(fake.calls.length, 2)
  const args = fake.calls[1]
  assert.ok(args.includes('-N') && args.includes('-T'))
  assert.ok(args.includes('StrictHostKeyChecking=yes'))
  assert.ok(args.includes('ForwardAgent=no'))
  assert.ok(args.includes('127.0.0.1:45231:127.0.0.1:31415'))
  assert.equal(args[args.indexOf('-i') + 1], connection.identityFile)
  assert.deepEqual(args.slice(-2), ['--', 'work'])
  controller.abort()
  await tunnel.closed
  assert.equal(fake.children[1].exitCode, 0)
})

test('指定身份文件不存在时明确失败，不回退到其他身份或启动 SSH', async () => {
  const fake = fakeProcesses('hostname work.example\n')
  const start = createSshTunnelStarter({
    spawn: fake.run,
    executable: async () => '/usr/bin/ssh',
    signalGroup: fake.signalGroup,
  })
  await assert.rejects(
    start({ ...connection, identityFile: path.join(root, 'missing') }, new AbortController().signal),
    /身份文件不存在或不可读/,
  )
  assert.equal(fake.calls.length, 0)
})

test('SSH 生效配置含额外转发时不启动受管隧道', async () => {
  const fake = fakeProcesses('localforward 0.0.0.0:9000 127.0.0.1:9000\n')
  const start = createSshTunnelStarter({
    spawn: fake.run,
    signalGroup: fake.signalGroup,
    executable: async () => '/usr/bin/ssh',
  })
  await assert.rejects(start(connection, new AbortController().signal), /额外端口转发/)
  assert.equal(fake.calls.length, 1)
})

test('SSH 配置预检有界超时，不遗留进程或启动隧道', async () => {
  const fake = fakeProcesses('', true)
  const start = createSshTunnelStarter({
    spawn: fake.run,
    signalGroup: fake.signalGroup,
    executable: async () => '/usr/bin/ssh',
    preflightTimeoutMs: 5,
  })
  await assert.rejects(start(connection, new AbortController().signal), /配置检查超时/)
  assert.equal(fake.calls.length, 1)
  assert.equal(fake.children[0].exitCode, 0)
})

test('SSH 父进程已退出仍清理组内代理子进程，TERM无效时等待KILL', async () => {
  const fake = fakeProcesses('localforward none\nremoteforward none\n')
  const signals: Array<NodeJS.Signals | 0> = []
  let descendant = true
  const start = createSshTunnelStarter({
    spawn: fake.run,
    executable: async () => '/usr/bin/ssh',
    allocatePort: async () => 45232,
    ready: async () => true,
    signalGroup: (pid, signal) => {
      if (pid === 100) return false
      signals.push(signal)
      if (signal === 'SIGTERM') {
        fake.children[1].kill('SIGTERM')
        return true
      }
      if (signal === 'SIGKILL') {
        descendant = false
        return true
      }
      return descendant
    },
  })
  const tunnel = await start(connection, new AbortController().signal)
  await tunnel.stop()
  assert.equal(descendant, false)
  assert.ok(signals.includes('SIGTERM') && signals.includes('SIGKILL'))
})
