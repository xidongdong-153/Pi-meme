import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'vitest'
import { readLocalHostStatus } from '../src/host-status'
import { startHostServer } from '../src/server'

async function stopped(child: ChildProcess) {
  if (child.exitCode !== null) return child.exitCode
  return new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server 入口退出超时')), 10000)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
    child.once('error', (cause) => {
      clearTimeout(timer)
      reject(cause)
    })
  })
}

test('Server 入口复用兼容 Host 后成功退出，不接管；目录或创建参数冲突明确失败', { timeout: 20000 }, async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'pi-server-startup-')))
  const host = await startHostServer({ dataRoot: root, testCredentials: true, localAutoLogin: true, owner: 'desktop' })
  const children: ChildProcess[] = []
  const launch = (extra: NodeJS.ProcessEnv = {}) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PI_MEME_DATA_ROOT: root,
      PI_MEME_PORT: new URL(host.url).port,
      PI_MEME_TEST_CREDENTIALS: 'memory',
      PI_MEME_HOST: '127.0.0.1',
    }
    for (const key of ['PI_MEME_TOKEN', 'PI_MEME_TLS_CERT', 'PI_MEME_TLS_KEY', 'PI_MEME_WEB_ROOT']) delete env[key]
    const child = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/main.ts'], {
      env: { ...env, ...extra },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(child)
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    return { child, output: () => output }
  }
  try {
    const reused = launch()
    assert.equal(await stopped(reused.child), 0)
    assert.match(reused.output(), /复用已有 Host.*Desktop/)
    assert.equal((await readLocalHostStatus(host.url))?.instanceId, host.host.instanceId)
    const mismatch = launch({ PI_MEME_DATA_ROOT: `${root}/different` })
    assert.equal(await stopped(mismatch.child), 1)
    assert.match(mismatch.output(), /不同数据目录/)
    const explicit = launch({ PI_MEME_TOKEN: 'test-explicit-token' })
    assert.equal(await stopped(explicit.child), 1)
    assert.match(explicit.output(), /新的令牌/)
    assert.ok(!explicit.output().includes('test-explicit-token'))
  } finally {
    for (const child of children)
      if (child.exitCode === null) {
        child.kill('SIGTERM')
        await stopped(child)
      }
    await host.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('Server 入口创建 Host，退出信号关闭监听并释放数据锁', { timeout: 20000 }, async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'pi-server-owned-')))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PI_MEME_DATA_ROOT: root,
    PI_MEME_PORT: '0',
    PI_MEME_TEST_CREDENTIALS: 'memory',
    PI_MEME_HOST: '127.0.0.1',
  }
  for (const key of ['PI_MEME_TOKEN', 'PI_MEME_TLS_CERT', 'PI_MEME_TLS_KEY', 'PI_MEME_WEB_ROOT']) delete env[key]
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/main.ts'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  try {
    let url = output.match(/Host 已启动：(http:\/\/127\.0\.0\.1:\d+)/)?.[1]
    const deadline = Date.now() + 10000
    while (!url) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Server 未就绪：${output}`)
      await delay(25)
      url = output.match(/Host 已启动：(http:\/\/127\.0\.0\.1:\d+)/)?.[1]
    }
    assert.equal((await readLocalHostStatus(url))?.owner, 'server')
    child.kill('SIGTERM')
    assert.equal(await stopped(child), 0)
    assert.equal(await readLocalHostStatus(url), undefined)
    const next = await startHostServer({ dataRoot: root, testCredentials: true })
    await next.dispose()
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      await stopped(child)
    }
    await rm(root, { recursive: true, force: true })
  }
})
