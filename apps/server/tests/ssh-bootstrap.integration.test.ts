import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, test } from 'vitest'
import { sshHostRuntimeHomeRelativeDirectory } from '@pi-meme/contracts/storage-paths'

type Result = { protocolVersion: 1; port: number; hostId: string; token: string; version: string }
type Descriptor = Omit<Result, 'token'> & { pid: number; instanceId: string }
const entry = fileURLToPath(new URL('../src/ssh-bootstrap.ts', import.meta.url))
const tsx = import.meta.resolve('tsx')
const homes: string[] = []
const children = new Set<ChildProcess>()
const hosts = new Set<number>()

function environment(home: string) {
  return { HOME: home, PATH: process.env.PATH, TMPDIR: home, NODE_ENV: 'test' }
}

function runtime(home: string) {
  return path.join(home, sshHostRuntimeHomeRelativeDirectory)
}

async function descriptor(home: string): Promise<Descriptor> {
  return JSON.parse(await readFile(path.join(runtime(home), 'runtime.json'), 'utf8')) as Descriptor
}

async function fixture() {
  const home = await mkdtemp('/tmp/pi-ssh-')
  homes.push(home)
  return home
}

function execute(home: string, input: unknown = { protocolVersion: 1 }, extraEnv: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, ['--import', tsx, entry], {
    env: { ...environment(home), ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.add(child)
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (value: string) => (stdout += value))
  child.stderr.setEncoding('utf8').on('data', (value: string) => (stderr += value))
  child.stdin.end(JSON.stringify(input))
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('SSH 引导测试子进程超时'))
    }, 70000)
    child.once('error', reject)
    child.once('close', (code) => {
      clearTimeout(timer)
      children.delete(child)
      resolve({ code, stdout, stderr })
    })
  })
}

async function connect(home: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const execution = await execute(home, { protocolVersion: 1 }, extraEnv)
  assert.equal(execution.code, 0, execution.stderr)
  assert.equal(execution.stderr, '')
  assert.equal(execution.stdout.trim().split('\n').length, 1)
  const result = JSON.parse(execution.stdout) as Result
  assert.equal(result.protocolVersion, 1)
  assert.ok(result.port > 0)
  assert.ok(result.token.length >= 32)
  hosts.add((await descriptor(home)).pid)
  return result
}

async function until(check: () => Promise<boolean>, timeout = 10000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await delay(50)
  }
  throw new Error('等待 SSH Host 生命周期变化超时')
}

async function status(port: number) {
  return fetch(`http://127.0.0.1:${port}/api/status`, {
    headers: { Connection: 'close' },
    signal: AbortSignal.timeout(1000),
  })
}

afterEach(async () => {
  for (const child of children) child.kill('SIGKILL')
  children.clear()
  for (const home of homes) {
    const current = await descriptor(home).catch(() => undefined)
    if (current) hosts.add(current.pid)
  }
  for (const pid of hosts) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // 用例中已经停止的测试进程无需再次回收。
    }
  }
  await Promise.all(
    homes.map(async (home) => {
      await until(async () => !(await lstat(path.join(runtime(home), 'runtime.json')).catch(() => undefined))).catch(
        () => {},
      )
      await rm(home, { recursive: true, force: true })
    }),
  )
  homes.length = 0
  hosts.clear()
})

describe('SSH 包内引导真实进程', () => {
  test('拒绝非协议输入，不接受数据根或令牌覆盖', async () => {
    const home = await fixture()
    const result = await execute(home, { protocolVersion: 1, token: '不应记录的输入', dataRoot: '/other' })
    assert.equal(result.code, 1)
    assert.equal(result.stdout, '')
    assert.deepEqual(JSON.parse(result.stderr), {
      code: 'host-start',
      message: 'SSH 引导协议无效，只接受 protocolVersion: 1',
    })
    assert.equal(await lstat(runtime(home)).catch(() => undefined), undefined)
  })

  test('并发连接只启动一个独立 Host，退出引导后继续运行，凭据不写入运行描述', async () => {
    const home = await fixture()
    const [first, second] = await Promise.all([
      connect(home, { PI_MEME_DATA_ROOT: '/不允许覆盖', PI_MEME_TOKEN: '不允许继承令牌', PI_MEME_PORT: '1' }),
      connect(home),
    ])
    assert.deepEqual(first, second)
    assert.notEqual(first.token, '不允许继承令牌')
    const current = await descriptor(home)
    assert.equal((await lstat(runtime(home))).mode & 0o777, 0o700)
    assert.equal((await lstat(path.join(runtime(home), 'runtime.json'))).mode & 0o777, 0o600)
    assert.equal('token' in current, false)
    assert.ok(!(await readFile(path.join(runtime(home), 'runtime.json'), 'utf8')).includes(first.token))
    assert.equal(current.port, first.port)
    const response = await status(first.port)
    assert.equal(response.status, 200)
    const value = (await response.json()) as { hostId: string; dataRoot: string; instanceId: string }
    assert.equal(value.hostId, first.hostId)
    assert.equal(value.instanceId, current.instanceId)
    assert.equal(value.dataRoot, await realpath(path.join(home, '.pi-meme')))
    const auth = (token?: string) =>
      fetch(`http://127.0.0.1:${first.port}/api/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${first.port}` },
        body: JSON.stringify(token ? { token } : {}),
      })
    assert.equal((await auth()).status, 401)
    assert.equal((await auth(first.token)).status, 200)
    assert.deepEqual(await connect(home), first)
    const authFile = path.join(home, '.pi-meme/credentials/auth.json')
    const saved = await readFile(authFile, 'utf8')
    const malformed = '{"host:token":"不得泄露的凭据片段"'
    await writeFile(authFile, malformed)
    const rejected = await execute(home)
    assert.equal(rejected.code, 1)
    assert.equal(rejected.stdout, '')
    assert.deepEqual(JSON.parse(rejected.stderr), {
      code: 'host-conflict',
      message: '无法读取 SSH Host 凭据或凭据 JSON 无效，原文件未修改',
    })
    assert.equal(await readFile(authFile, 'utf8'), malformed)
    await writeFile(authFile, saved)
  }, 30000)

  test('正常停止后下次连接重启，保留 Host 身份与凭据', async () => {
    const home = await fixture()
    const first = await connect(home)
    const original = await descriptor(home)
    process.kill(original.pid, 'SIGTERM')
    await until(async () => !(await lstat(path.join(runtime(home), 'runtime.json')).catch(() => undefined)))
    const second = await connect(home)
    const current = await descriptor(home)
    assert.notEqual(current.pid, original.pid)
    assert.notEqual(current.instanceId, original.instanceId)
    assert.equal(second.hostId, first.hostId)
    assert.equal(second.token, first.token)
    assert.equal((await status(second.port)).status, 200)
  }, 30000)

  test('自有 Host 异常退出后等待原数据锁过期再启动，不删除或绕过数据锁', async () => {
    const home = await fixture()
    const first = await connect(home)
    const original = await descriptor(home)
    process.kill(original.pid, 'SIGKILL')
    await until(async () => {
      try {
        process.kill(original.pid, 0)
        return false
      } catch {
        return true
      }
    })
    assert.equal((await descriptor(home)).pid, original.pid)
    const second = await connect(home)
    const current = await descriptor(home)
    assert.notEqual(current.pid, original.pid)
    assert.equal(second.hostId, first.hostId)
    assert.equal(second.token, first.token)
    assert.equal((await status(second.port)).status, 200)
  }, 65000)

  test('拒绝接管使用同一数据根的手工 Host，原 Host 保持运行', async () => {
    const home = await fixture()
    const manual = spawn(
      process.execPath,
      ['--import', tsx, fileURLToPath(new URL('../src/main.ts', import.meta.url))],
      {
        env: { ...environment(home), PI_MEME_PORT: '0', PI_MEME_DATA_ROOT: path.join(home, '.pi-meme') },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    children.add(manual)
    let output = ''
    let errors = ''
    manual.stdout.setEncoding('utf8').on('data', (value: string) => (output += value))
    manual.stderr.setEncoding('utf8').on('data', (value: string) => (errors += value))
    await until(async () => {
      assert.equal(manual.exitCode, null, `手工 Host 提前退出：${errors}`)
      return output.includes('Host 已启动：')
    }, 20000)
    const url = /Host 已启动：(http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1]
    assert.ok(url)
    const result = await execute(home)
    assert.equal(result.code, 1)
    assert.equal(result.stdout, '')
    const failure = JSON.parse(result.stderr) as { code: string; message: string }
    assert.equal(failure.code, 'host-conflict')
    assert.match(failure.message, /不会接管手工启动/)
    assert.equal((await fetch(`${url}/api/status`)).status, 200)
    assert.equal(await lstat(path.join(runtime(home), 'runtime.json')).catch(() => undefined), undefined)
    const stopped = new Promise<void>((resolve) => manual.once('close', () => resolve()))
    manual.kill('SIGTERM')
    await stopped
    children.delete(manual)
  }, 45000)

  test('自有活跃运行信息不匹配时明确冲突，不启动或停止其他进程', async () => {
    const home = await fixture()
    const first = await connect(home)
    const current = await descriptor(home)
    await writeFile(path.join(runtime(home), 'runtime.json'), JSON.stringify({ ...current, version: '其他版本' }), {
      mode: 0o600,
    })
    const result = await execute(home)
    assert.equal(result.code, 1)
    assert.equal((JSON.parse(result.stderr) as { code: string }).code, 'host-conflict')
    assert.equal((await status(first.port)).status, 200)
    assert.equal((await descriptor(home)).pid, current.pid)
  }, 30000)
})
