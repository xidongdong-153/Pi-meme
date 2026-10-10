import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, X509Certificate } from 'node:crypto'
import { get } from 'node:https'
import { startHostServer } from '@pi-meme/host/server'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'

async function waitFor<T>(read: () => Promise<T | undefined>, label: string) {
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await delay(100)
  }
  throw new Error(`打包应用验收等待超时：${label}`)
}

async function runPackagedSmoke(mode: 'local' | 'recovery' | 'remote') {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-meme-package-test-'))
  const fixture = await useFakeAgent(root, { reply: () => ({ text: '打包应用回复', delayMs: 100 }) })
  const dataRoot = path.join(root, 'userData')
  await mkdir(dataRoot, { recursive: true })
  await writeFile(
    path.join(dataRoot, 'test-credentials.json'),
    JSON.stringify(Object.fromEntries(fixture.credentials.entries())),
    { mode: 0o600 },
  )
  let remoteHost: Awaited<ReturnType<typeof startHostServer>> | undefined
  let certificate: Buffer | undefined
  let certificatePin: string | undefined
  if (mode === 'remote') {
    const keyFile = path.join(root, 'test-key.pem')
    const certFile = path.join(root, 'test-cert.pem')
    await promisify(execFile)('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
      '-keyout',
      keyFile,
      '-out',
      certFile,
    ])
    certificate = await readFile(certFile)
    certificatePin = createHash('sha256')
      .update(new X509Certificate(certificate).publicKey.export({ type: 'spki', format: 'der' }))
      .digest('base64')
    remoteHost = await startHostServer({
      dataRoot,
      credentials: fixture.credentials,
      token: 'remote-test-token',
      staticDirectory: fileURLToPath(new URL('../../web/dist', import.meta.url)),
      tls: { key: await readFile(keyFile), cert: certificate },
    })
  }
  const listener = createServer()
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const address = listener.address()
  assert.ok(address && typeof address === 'object')
  const port = address.port
  await new Promise<void>((resolve, reject) => listener.close((cause) => (cause ? reject(cause) : resolve())))
  const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const packagedApp =
    process.env.PI_DESKTOP_PACKAGED_APP ?? path.join(desktop, 'out', `pi-meme-darwin-${process.arch}`, 'pi-meme.app')
  const child = spawn(
    path.join(packagedApp, 'Contents/MacOS/pi-meme'),
    [
      `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${path.join(dataRoot, 'desktop-cache')}`,
      ...(certificatePin ? [`--ignore-certificate-errors-spki-list=${certificatePin}`] : []),
    ],
    {
      env: {
        ...process.env,
        PI_MEME_DATA_ROOT: dataRoot,
        PI_MEME_TEST_CREDENTIALS: 'memory',
        PI_MEME_REMOTE_HOST: mode === 'recovery' ? `https://127.0.0.1:${port}` : (remoteHost?.url ?? ''),
        PI_MEME_TOKEN: remoteHost ? 'remote-test-token' : '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let output = ''
  child.stderr.on('data', (value: Buffer) => {
    output = (output + value.toString()).slice(-12000)
  })
  let socket: WebSocket | undefined
  try {
    const page = await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`打包应用提前退出：${child.exitCode}\n${output}`)
      const response = await fetch(`http://127.0.0.1:${port}/json/list`).catch(() => undefined)
      if (!response?.ok) return undefined
      const pages = (await response.json()) as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>
      return pages.find(
        (value) =>
          value.type === 'page' &&
          (mode === 'recovery'
            ? value.url.startsWith('data:text/html')
            : value.url.startsWith(remoteHost?.url ?? 'http://127.0.0.1:')),
      )
    }, '共享 UI 页面')
    socket = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise<void>((resolve, reject) => {
      socket!.addEventListener('open', () => resolve(), { once: true })
      socket!.addEventListener('error', () => reject(new Error('无法连接打包应用验收端口')), { once: true })
    })
    let id = 0
    const evaluate = (expression: string) =>
      new Promise<unknown>((resolve, reject) => {
        const current = ++id
        let timer: ReturnType<typeof setTimeout>
        const receive = (event: MessageEvent) => {
          const message = JSON.parse(String(event.data)) as {
            id: number
            result?: { exceptionDetails?: unknown; result: { value?: unknown } }
            error?: unknown
          }
          if (message.id !== current) return
          clearTimeout(timer)
          socket!.removeEventListener('message', receive)
          if (message.error || message.result?.exceptionDetails)
            reject(new Error(`打包应用脚本失败：${JSON.stringify(message.error ?? message.result?.exceptionDetails)}`))
          else resolve(message.result?.result.value)
        }
        timer = setTimeout(() => {
          socket!.removeEventListener('message', receive)
          reject(new Error('打包应用脚本等待超时'))
        }, 30000)
        socket!.addEventListener('message', receive)
        socket!.send(
          JSON.stringify({
            id: current,
            method: 'Runtime.evaluate',
            params: { expression, awaitPromise: true, returnByValue: true },
          }),
        )
      })
    if (mode === 'recovery') {
      assert.equal(await evaluate('document.title'), 'Host 连接失败')
      assert.equal(await evaluate('typeof window.piPlatform.retryHostConnection'), 'function')
      assert.match(
        String(
          await evaluate('window.piPlatform.getHostConnection().then(() => "允许").catch(cause => cause.message)'),
        ),
        /不允许|恢复页/,
      )
      await evaluate('document.getElementById("local").click()')
    }
    await waitFor(
      async () =>
        (await evaluate('Boolean(window.piMemeClient && document.querySelector("[aria-label=消息]"))'))
          ? true
          : undefined,
      '共享聊天界面',
    )
    assert.ok((await readdir(path.join(dataRoot, 'desktop-cache'))).length > 0, 'Electron profile 写入临时目录')
    assert.equal(await evaluate('typeof window.piDesktop'), 'undefined', '打包页面不提供业务 IPC Bridge')
    assert.equal(
      await evaluate(
        'window.piMemeClient.getSnapshot().then(value => value.models.some(model => model.id === "first"))',
      ),
      true,
    )
    await evaluate(
      'window.piMemeClient.getConnection().then(value => window.piMemeClient.prompt(value.sessionKey, "打包消息"))',
    )
    await waitFor(
      async () =>
        (await evaluate(
          'window.piMemeClient.getSnapshot().then(value => !value.state.isStreaming && !value.state.isCompacting && value.messages.some(message => message.role === "assistant" && JSON.stringify(message.content).includes("打包应用回复")))',
        ))
          ? true
          : undefined,
      'Worker 假模型回复',
    )
    const sessionFile = await evaluate('window.piMemeClient.getSnapshot().then(value => value.connection.sessionFile)')
    assert.equal(typeof sessionFile, 'string')
    assert.match(await readFile(sessionFile as string, 'utf8'), /打包消息/)
  } finally {
    socket?.close()
    if (child.exitCode === null) {
      const exited = once(child, 'exit').catch(() => [])
      child.kill('SIGTERM')
      await Promise.race([exited, delay(10000)])
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await exited
      }
    }
    if (remoteHost) {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        get(remoteHost!.url, { ca: certificate }, (response) => {
          response.resume()
          resolve(response.statusCode)
        }).on('error', reject)
      })
      assert.equal(status, 200, '退出 Desktop 不停止外部 HTTPS Host')
      await remoteHost.dispose()
    }
    await fixture.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

const cases = {
  local: '实际 macOS 应用启动独立 Host，加载共享 UI 并通过 Worker 完成假模型消息',
  recovery: '实际应用远程连接失败显示受限恢复页，点击本地 Host 后完成假模型消息',
  remote: '实际应用连接 HTTPS Host 完成假模型消息，退出不停止外部 Host',
} as const
for (const mode of ['local', 'recovery', 'remote'] as const)
  test(
    cases[mode],
    { skip: process.platform !== 'darwin' ? '实际应用验收只适用于 macOS' : false, timeout: 120000 },
    () => runPackagedSmoke(mode),
  )
