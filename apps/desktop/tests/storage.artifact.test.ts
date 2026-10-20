import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, type Browser } from '@playwright/test'
import type { DesktopBridge } from '@pi-meme/contracts/desktop'
import { workspaceKey } from '@pi-meme/pi-runtime/runtime-paths'

async function waitFor<T>(read: () => Promise<T | undefined>) {
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    const result = await read()
    if (result !== undefined) return result
    await delay(100)
  }
  throw new Error('真实存储维护验收等待超时')
}

test(
  '真实 .app 自动 relaunch 完成迁移与缓存清理，保留数据且普通 ASAR 文件不被展开',
  { skip: process.platform !== 'darwin', timeout: 150000 },
  async () => {
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'pi-meme-storage-artifact-')))
    const home = path.join(directory, 'home')
    const source = path.join(home, '.pi-meme')
    const target = path.join(directory, 'target')
    const anchor = path.join(directory, 'desktop')
    const cwd = path.join(source, 'standalone-workspaces/fixture')
    const hostId = randomUUID()
    const sessionId = randomUUID()
    await Promise.all([cwd, target, anchor].map((folder) => mkdir(folder, { recursive: true })))
    await writeFile(path.join(source, 'host-id'), hostId)
    await writeFile(path.join(source, 'auth.json'), '{"fixture":"not-a-real-secret"}', { mode: 0o600 })
    const archive = Buffer.from([0, 97, 115, 97, 114, 255])
    await writeFile(path.join(source, 'user-owned.asar'), archive)
    const sessionFile = path.join(source, 'sessions', workspaceKey(cwd), 'fixture.jsonl')
    await mkdir(path.dirname(sessionFile), { recursive: true })
    await writeFile(
      sessionFile,
      `${JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd, timestamp: new Date().toISOString() })}\n`,
    )
    const pointer = path.join(anchor, 'storage-location.json')
    await writeFile(
      pointer,
      JSON.stringify({
        version: 1,
        dataRoot: source,
        backupPaths: [],
        pending: { id: randomUUID(), kind: 'migrate', source, target, hostId },
      }),
    )
    const listener = createServer()
    listener.listen(0, '127.0.0.1')
    await once(listener, 'listening')
    const address = listener.address()
    assert.ok(address && typeof address === 'object')
    const port = address.port
    await new Promise<void>((resolve, reject) => listener.close((cause) => (cause ? reject(cause) : resolve())))
    const app =
      process.env.PI_DESKTOP_PACKAGED_APP ??
      path.resolve('apps/desktop/out', `Pi meme-darwin-${process.arch}`, 'Pi meme.app')
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      PI_MEME_PORT: '0',
      PI_MEME_REMOTE_HOST: '',
      PI_MEME_TOKEN: '',
    }
    delete env.PI_MEME_DATA_ROOT
    delete env.PI_MEME_TEST_CREDENTIALS
    let child: ChildProcess | undefined
    let browser: Browser | undefined
    let output = ''
    async function connect() {
      const base = `http://127.0.0.1:${port}`
      await waitFor(async () => {
        const response = await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(1000) }).catch(() => undefined)
        if (!response?.ok) return undefined
        const pages = (await response.json()) as Array<{ type: string; url: string }>
        return pages.some((entry) => entry.type === 'page' && entry.url.startsWith('http://127.0.0.1:'))
          ? true
          : undefined
      })
      browser = await chromium.connectOverCDP(base)
      const page = await waitFor(async () =>
        browser!
          .contexts()
          .flatMap((context) => context.pages())
          .find((value) => value.url().startsWith('http://127.0.0.1:')),
      )
      await page.waitForFunction(() => Boolean((window as Window & { piMemeClient?: DesktopBridge }).piMemeClient))
      return page
    }
    try {
      child = spawn(
        path.join(app, 'Contents/MacOS/Pi meme'),
        [`--user-data-dir=${anchor}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'],
        { env, stdio: ['ignore', 'pipe', 'pipe'] },
      )
      child.stderr?.on('data', (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-16000)
      })
      await waitFor(async () => {
        const saved = JSON.parse(await readFile(pointer, 'utf8')) as {
          dataRoot: string
          pending?: unknown
          lastError?: string
        }
        if (saved.lastError) throw new Error(saved.lastError)
        return saved.dataRoot === target && !saved.pending ? true : undefined
      })
      let page = await connect()
      const info = await page.evaluate(() =>
        (window as Window & { piMemeClient: DesktopBridge }).piMemeClient.getStorageInfo(),
      )
      assert.deepEqual(info, { hostId, dataRoot: target })
      assert.deepEqual(await readFile(path.join(target, 'user-owned.asar')), archive)
      const credentials = JSON.parse(await readFile(path.join(target, 'auth.json'), 'utf8')) as Record<string, string>
      assert.equal(credentials.fixture, 'not-a-real-secret')
      assert.equal(typeof credentials['host:token'], 'string')
      const relocatedFile = path.join(
        target,
        'sessions',
        workspaceKey(path.join(target, 'standalone-workspaces/fixture')),
        'fixture.jsonl',
      )
      assert.equal((JSON.parse((await readFile(relocatedFile, 'utf8')).trim()) as { id: string }).id, sessionId)
      await writeFile(path.join(target, 'remote-services.json'), '[]')
      await page.getByRole('button', { name: '设置', exact: true }).click()
      await page.getByTestId('storage-root').waitFor()
      await page.getByRole('button', { name: '清理缓存', exact: true }).click()
      await page.getByRole('button', { name: '清理并重启', exact: true }).click()
      await waitFor(async () => {
        const absent = await readFile(path.join(target, 'remote-services.json')).then(
          () => false,
          () => true,
        )
        const saved = JSON.parse(await readFile(pointer, 'utf8')) as { pending?: unknown; lastError?: string }
        if (saved.lastError) throw new Error(saved.lastError)
        return absent && !saved.pending ? true : undefined
      })
      await browser?.close().catch(() => {})
      browser = undefined
      page = await connect()
      assert.deepEqual(
        await page.evaluate(() => (window as Window & { piMemeClient: DesktopBridge }).piMemeClient.getStorageInfo()),
        { hostId, dataRoot: target },
      )
      assert.equal((JSON.parse((await readFile(relocatedFile, 'utf8')).trim()) as { id: string }).id, sessionId)
      assert.equal(
        (JSON.parse(await readFile(path.join(source, '.pi-meme-relocated.json'), 'utf8')) as { target: string }).target,
        target,
      )
    } catch (cause) {
      throw new Error(`真实存储维护验收失败：${cause instanceof Error ? cause.stack : String(cause)}\n${output}`, {
        cause,
      })
    } finally {
      await browser?.close().catch(() => {})
      if (child?.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const pattern = `^${escape(path.join(app, 'Contents/MacOS/Pi meme'))} --user-data-dir=${escape(anchor)}( |$)`
      // relaunch 后 PID 已变；只终止命令行严格匹配本次临时 profile 的主进程。
      for (let attempt = 0; attempt < 10; attempt++) {
        const result = await promisify(execFile)('pgrep', ['-f', pattern]).catch(() => ({ stdout: '' }))
        for (const value of result.stdout.trim().split(/\s+/).filter(Boolean)) {
          try {
            process.kill(Number(value), 'SIGTERM')
          } catch {
            /* 进程可能已经退出。 */
          }
        }
        await delay(100)
      }
      await rm(directory, { recursive: true, force: true })
    }
  },
)
