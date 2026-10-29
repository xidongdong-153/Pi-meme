import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, vi } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))

async function fixture(platform: string, scenario = '') {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-meme-start-'))
  const log = path.join(directory, 'events.jsonl')
  const preload = path.join(directory, 'platform.cjs')
  const pnpm = path.join(directory, 'pnpm.cjs')
  const descendantFile = path.join(directory, 'child.cjs')
  await writeFile(preload, `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} })`)
  await writeFile(
    descendantFile,
    `const fs = require('node:fs')
const record = (type) => fs.appendFileSync(process.env.START_TEST_LOG, JSON.stringify({ type, name: process.argv[2] + ' child', pid: process.pid }) + '\\n')
process.on('SIGTERM', () => { record('stop'); process.exit(0) })
record('ready')
setInterval(() => {}, 1000)
`,
  )
  await writeFile(
    pnpm,
    `#!/usr/bin/env node
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const args = process.argv.slice(2)
const name = args.includes('start:server') ? 'Host' : args.includes('start:web') ? 'Web' : 'Desktop'
const record = (event) => fs.appendFileSync(process.env.START_TEST_LOG, JSON.stringify({ name, pid: process.pid, ...event }) + '\\n')
record({ type: 'start', args, env: process.env.NODE_ENV })
if (process.env.START_TEST_SCENARIO === 'reuse' && name === 'Host') process.exit(0)
const descendant = spawn(process.execPath, [${JSON.stringify(descendantFile)}, name], { stdio: 'inherit' })
process.on('SIGTERM', () => {
  record({ type: 'stop' })
  if (descendant.exitCode !== null) process.exit(0)
  descendant.once('exit', () => process.exit(0))
})
if (process.env.START_TEST_SCENARIO === 'failure' && name === 'Web') {
  const timer = setInterval(() => {
    const events = fs.readFileSync(process.env.START_TEST_LOG, 'utf8')
    if (events.includes('Host child') && events.includes('Web child')) {
      clearInterval(timer)
      process.exit(7)
    }
  }, 20)
}
`,
  )
  await chmod(pnpm, 0o755)
  const child = spawn(process.execPath, ['--import', preload, '--import', 'tsx', 'scripts/start.mts'], {
    cwd: root,
    env: {
      ...process.env,
      npm_execpath: pnpm,
      NODE_ENV: 'production',
      TMPDIR: directory,
      TMP: directory,
      TEMP: directory,
      START_TEST_LOG: log,
      START_TEST_SCENARIO: scenario,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => (output += String(chunk)))
  child.stderr.on('data', (chunk) => (output += String(chunk)))
  const closed = new Promise<number | null>((resolve) => child.once('close', resolve))
  async function events() {
    const content = await readFile(log, 'utf8').catch(() => '')
    return content
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; name: string; pid: number; args?: string[]; env?: string })
  }
  return {
    child,
    closed,
    events,
    output: () => output,
    async cleanup() {
      child.kill('SIGTERM')
      await closed
      for (const event of await events()) {
        if (event.type !== 'start') continue
        try {
          process.kill(-event.pid, 'SIGKILL')
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') throw cause
        }
      }
      await rm(directory, { recursive: true, force: true })
    },
  }
}

test.each(['darwin', 'linux'])('%s 选择开发入口，Ctrl+C 停止命令及其子进程', async (platform) => {
  const app = await fixture(platform)
  const names = platform === 'darwin' ? ['Desktop'] : ['Host', 'Web']
  try {
    await vi.waitFor(async () => {
      assert.equal((await app.events()).filter((event) => event.type === 'ready').length, names.length)
    })
    const starts = (await app.events()).filter((event) => event.type === 'start')
    assert.deepEqual(starts.map((event) => event.name).sort(), names)
    assert.ok(starts.every((event) => event.env === 'development'))
    if (platform === 'darwin') assert.deepEqual(starts[0].args, ['--filter', 'pi-meme', 'start'])
    app.child.kill('SIGINT')
    assert.equal(await app.closed, 130)
    const stops = (await app.events()).filter((event) => event.type === 'stop')
    assert.deepEqual(
      stops.map((event) => event.name).sort(),
      names.flatMap((name) => [name, `${name} child`]),
    )
  } finally {
    await app.cleanup()
  }
})

test('Server 复用成功退出后 Web 继续运行，SIGTERM 可以停止入口', async () => {
  const app = await fixture('linux', 'reuse')
  try {
    await vi.waitFor(async () => {
      assert.ok((await app.events()).some((event) => event.name === 'Web child'))
      assert.ok((await app.events()).some((event) => event.name === 'Host'))
    })
    assert.equal(app.child.exitCode, null)
    app.child.kill('SIGTERM')
    assert.equal(await app.closed, 143)
    assert.ok((await app.events()).some((event) => event.name === 'Web child' && event.type === 'stop'))
  } finally {
    await app.cleanup()
  }
})

test('Web 失败时保留退出码，并停止 Host 和残留子进程', async () => {
  const app = await fixture('linux', 'failure')
  try {
    assert.equal(await app.closed, 7)
    const stops = (await app.events()).filter((event) => event.type === 'stop').map((event) => event.name)
    assert.deepEqual(stops.sort(), ['Host', 'Host child', 'Web child'])
  } finally {
    await app.cleanup()
  }
})

test('不支持的平台不启动任何进程', async () => {
  const app = await fixture('win32')
  try {
    assert.equal(await app.closed, 1)
    assert.deepEqual(await app.events(), [])
    assert.match(app.output(), /开发入口不支持 win32/)
  } finally {
    await app.cleanup()
  }
})
