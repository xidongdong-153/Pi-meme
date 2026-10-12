import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { get } from 'node:https'
import { startHostServer } from '@pi-meme/host/server'
import { once } from 'node:events'
import { constants } from 'node:fs'
import { access, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import type { PiSlashCommand } from '@pi-meme/contracts/pi'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'
import { createDevkitAppPackage } from '../../../tests/fixtures/devkit-app'

async function waitFor<T>(read: () => Promise<T | undefined>, label: string) {
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await delay(100)
  }
  throw new Error(`打包应用验收等待超时：${label}`)
}

async function runPackagedSmoke(mode: 'local' | 'recovery' | 'remote' | 'fresh', existingRoot?: string) {
  const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const packagedApp =
    process.env.PI_DESKTOP_PACKAGED_APP ?? path.join(desktop, 'out', `pi-meme-darwin-${process.arch}`, 'pi-meme.app')
  const esbuildBinary = path.join(
    packagedApp,
    'Contents/Resources/app.asar.unpacked/node_modules/@esbuild',
    `${process.platform}-${process.arch}`,
    process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild',
  )
  assert.ok((await stat(esbuildBinary)).isFile(), '打包应用必须包含真实解包的esbuild二进制文件')
  await access(esbuildBinary, constants.X_OK)
  const root = existingRoot ?? (await mkdtemp(path.join(tmpdir(), 'pi-meme-package-test-')))
  const fixture = await useFakeAgent(root, { reply: () => ({ text: '打包应用回复', delayMs: 100 }) })
  const dataRoot = path.join(root, 'userData')
  await mkdir(dataRoot, { recursive: true })
  if (mode !== 'fresh')
    await writeFile(
      path.join(dataRoot, 'auth.json'),
      JSON.stringify(Object.fromEntries(fixture.credentials.entries())),
      {
        mode: 0o600,
      },
    )
  let remoteHost: Awaited<ReturnType<typeof startHostServer>> | undefined
  let certificate: Buffer | undefined
  let certificateFile: string | undefined
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
    certificateFile = certFile
    const remoteDataRoot = path.join(root, 'remote-data')
    await mkdir(path.join(remoteDataRoot, 'pi'), { recursive: true })
    await writeFile(path.join(remoteDataRoot, 'pi', 'models.json'), await readFile(fixture.modelsFile))
    await writeFile(
      path.join(remoteDataRoot, 'auth.json'),
      JSON.stringify(Object.fromEntries(fixture.credentials.entries())),
      { mode: 0o600 },
    )
    remoteHost = await startHostServer({
      dataRoot: remoteDataRoot,
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
  const child = spawn(
    path.join(packagedApp, 'Contents/MacOS/pi-meme'),
    [
      `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${path.join(dataRoot, 'desktop-cache')}`,
    ],
    {
      env: {
        ...process.env,
        PI_MEME_DATA_ROOT: dataRoot,
        ...(certificateFile ? { PI_MEME_TEST_TLS_CA: certificateFile } : {}),
        PI_MEME_TEST_CREDENTIALS: 'file',
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
      return pages.find((value) => value.type === 'page' && value.url.startsWith('http://127.0.0.1:'))
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
    await waitFor(
      async () =>
        (await evaluate('Boolean(window.piMemeClient && document.querySelector("[aria-label=消息]"))'))
          ? true
          : undefined,
      '共享聊天界面',
    )
    assert.ok((await readdir(path.join(dataRoot, 'desktop-cache'))).length > 0, 'Electron profile 写入临时目录')
    assert.equal(await evaluate('document.querySelector("input[type=password]") !== null'), false)
    const profileFiles = await readdir(path.join(dataRoot, 'desktop-cache'), { recursive: true })
    assert.equal(
      profileFiles.some((value) => path.basename(value) === 'Cookies'),
      false,
      '认证 Cookie 不写入磁盘',
    )
    assert.equal(typeof JSON.parse(await readFile(path.join(dataRoot, 'auth.json'), 'utf8'))['host:token'], 'string')
    if (mode === 'local') {
      const appPackage = await createDevkitAppPackage(root, 'packaged-devkit-app')
      const app = (await evaluate(`(async () => {
        const call = async (method, args = []) => {
          const response = await fetch('/api/rpc', {method:'POST', headers:{'Content-Type':'application/json'},
            body:JSON.stringify({requestId:crypto.randomUUID(), clientId:'package-app-test', method, args})})
          const value = await response.json()
          if (!response.ok || value.error) throw new Error(JSON.stringify(value.error))
          return value.result
        }
        const installed = await call('plugins:install-package', [${JSON.stringify(appPackage)}])
        const time = await call('packaged-devkit-app:time')
        await call('plugins:reload', [installed.id])
        const reloadedTime = await call('packaged-devkit-app:time')
        return {installed, time, reloadedTime}
      })()`)) as { installed: { id: string; status: string }; time: string; reloadedTime: string }
      assert.equal(app.installed.id, 'packaged-devkit-app')
      assert.equal(app.installed.status, 'active')
      assert.match(app.time, /^\d{4}-\d{2}-\d{2}T/)
      assert.match(app.reloadedTime, /^\d{4}-\d{2}-\d{2}T/)
      const result = (await evaluate(`(async () => {
        const call = async input => {
          const response = await fetch('/api/rpc', {method:'POST', headers:{'Content-Type':'application/json'},
            body:JSON.stringify({requestId:crypto.randomUUID(), clientId:'package-native-test', method:'resources:import', args:[input]})})
          return response.json()
        }
        const imported = await call({kind:'pi-package', files:[
          {path:'package.json', content:JSON.stringify({name:'packaged-esbuild-fixture', version:'1.0.0', pi:{extensions:['./extensions/index.ts']}})},
          {path:'extensions/index.ts', content:"import { value } from './helpers/value'; export default function(pi) { pi.on('session_start', (_event, ctx) => ctx.ui.setStatus('packaged-fixture', value)) }"},
          {path:'extensions/helpers/value.ts', content:"export const value: string = '打包原生扩展'"},
        ]})
        const rejected = await call({kind:'extension', name:'packaged-missing-dependency', content:"import missing from 'pi-meme-fixture-missing-dependency'; export default () => missing()"})
        return { imported, rejected }
      })()`)) as {
        imported: { result?: { items: Array<{ kind: string; owner: { name?: string } }> }; error?: unknown }
        rejected: { error?: { message: string } }
      }
      assert.equal(result.imported.error, undefined, JSON.stringify(result.imported.error))
      assert.ok(
        result.imported.result?.items.some(
          (item) => item.kind === 'extension' && item.owner.name === 'packaged-esbuild-fixture',
        ),
        '实际打包Host通过esbuild校验并导入带相对TS依赖的原生扩展',
      )
      assert.match(result.rejected.error?.message ?? '', /pi-meme-fixture-missing-dependency/)
    }
    if (mode === 'remote') {
      const saved = await waitFor(async () => {
        const value = (await evaluate('window.piPlatform.listSavedHostConnections()')) as unknown[]
        if (value.length) return value
        const failure = (await evaluate('window.piPlatform.getHostConnectionError()')) as { message?: string } | null
        if (failure?.message) throw new Error(`远程服务登记失败：${failure.message}`)
        return undefined
      }, '启动远程服务登记').catch((cause: unknown) => {
        throw new Error(`${String(cause)}\n${output}`)
      })
      assert.deepEqual(saved, [{ url: remoteHost!.url, hostId: remoteHost!.host.hostId }])
      const localOrigin = await evaluate('window.location.origin')
      assert.notEqual(localOrigin, remoteHost!.url)
      assert.equal(await evaluate('window.piPlatform.getHostConnection().then(value => value.local)'), true)
      assert.equal(await evaluate('window.piPlatform.getHostConnection().then(value => value.url)'), localOrigin)
      const failure = await evaluate(
        `window.piPlatform.setHostConnection({url:${JSON.stringify(remoteHost!.url)},token:'wrong-token'}).then(() => '').catch(cause => cause.message)`,
      )
      assert.match(String(failure), /认证失败/)
      assert.equal(await evaluate('window.location.origin'), localOrigin)
      assert.deepEqual(
        await evaluate('window.piPlatform.listSavedHostConnections()'),
        saved,
        '错误令牌不覆盖已保存连接',
      )
    }
    if (mode === 'recovery') {
      await waitFor(async () => {
        const error = (await evaluate('window.piPlatform.getHostConnectionError()')) as { local?: boolean } | null
        return error?.local === false ? true : undefined
      }, '远程登记失败保留本机界面')
      assert.equal(await evaluate('window.piPlatform.getHostConnection().then(value => value.local)'), true)
      assert.notEqual(await evaluate('document.title'), 'Host 连接失败')
    }
    if (mode === 'remote') {
      await evaluate(`(async () => {
        const call = async (prefix, hostId, method, args = [], sessionId) => {
          const response = await fetch(prefix + '/api/rpc', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({requestId: crypto.randomUUID(), clientId:'package-remote-test', hostId, method, args, sessionId}) })
          const value = await response.json()
          if (!response.ok || value.error) throw new Error(JSON.stringify(value.error))
          return value.result
        }
        const local = await window.piPlatform.getHostConnection()
        const services = await call('', local.hostId, 'host:services:list')
        const remote = services.find(service => service.address === ${JSON.stringify(remoteHost!.url)})
        if (!remote) throw new Error('远程服务未登记')
        const prefix = '/api/services/' + remote.id
        window.piMemeRemoteTestBridge = {
          getSnapshot: () => call(prefix, remote.hostId, 'pi:snapshot'),
          getConnection: () => call(prefix, remote.hostId, 'pi:connection'),
          prompt: (key, message) => call(prefix, remote.hostId, 'pi:prompt', [key,message,[],[]], key),
        }
        await call(prefix, remote.hostId, 'pi:new-session')
        const auth = await fetch(prefix + '/api/auth', {method:'POST', headers:{'Content-Type':'application/json'},body:'{}'})
        if (auth.headers.has('set-cookie')) throw new Error('代理泄漏远程认证Cookie')
      })()`)
    }
    assert.equal(await evaluate('typeof window.piDesktop'), 'undefined', '打包页面不提供业务 IPC Bridge')
    if (mode === 'fresh') {
      const auth = JSON.parse(await readFile(path.join(dataRoot, 'auth.json'), 'utf8'))
      assert.deepEqual(Object.keys(auth), ['host:token'])
      const source = fileURLToPath(new URL('../../../pi/skills/skill-creator', import.meta.url))
      const installed = path.join(dataRoot, 'builtin-resources/skills/skill-creator')
      for (const entry of await readdir(source, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue
        const relative = path.relative(source, path.join(entry.parentPath, entry.name))
        assert.deepEqual(
          await readFile(path.join(installed, relative)),
          await readFile(path.join(source, relative)),
          `内置 Skill Creator 完整分发：${relative}`,
        )
      }
      const commands = (await evaluate('window.piMemeClient.getCommands()')) as PiSlashCommand[]
      const creator = commands.find((command) => command.name === 'skill:skill-creator')
      assert.ok(creator, '无模型凭据时加载内置 Skill Creator')
      assert.equal(creator.builtin, true)
      assert.equal(creator.displayName, 'Skill Creator')
      assert.ok(creator.sourceInfo.path.startsWith(path.join(dataRoot, 'resources/snapshots')))
      assert.ok(creator.resourceId && creator.resourceRevision)
      await evaluate(`(() => {
        const input = document.querySelector('[contenteditable=true][aria-label="消息"]')
        input.textContent = '$'
        input.focus()
        const range = document.createRange()
        range.selectNodeContents(input)
        range.collapse(false)
        const selection = window.getSelection()
        selection.removeAllRanges()
        selection.addRange(range)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })()`)
      await waitFor(
        async () =>
          (await evaluate(
            '[...document.querySelectorAll("#composer-suggestions [role=option]")].some(option => option.textContent.includes("Skill Creator") && option.textContent.includes("内置"))',
          ))
            ? true
            : undefined,
        '内置技能候选渲染',
      )
      return
    }
    assert.equal(
      await evaluate(
        '(window.piMemeRemoteTestBridge ?? window.piMemeClient).getSnapshot().then(value => value.models.some(model => model.id === "first"))',
      ),
      true,
    )
    await evaluate(
      '(window.piMemeRemoteTestBridge ?? window.piMemeClient).getConnection().then(value => (window.piMemeRemoteTestBridge ?? window.piMemeClient).prompt(value.sessionKey, "打包消息"))',
    )
    await waitFor(
      async () =>
        (await evaluate(
          '(window.piMemeRemoteTestBridge ?? window.piMemeClient).getSnapshot().then(value => !value.state.isStreaming && !value.state.isCompacting && value.messages.some(message => message.role === "assistant" && JSON.stringify(message.content).includes("打包应用回复")))',
        ))
          ? true
          : undefined,
      'Worker 假模型回复',
    )
    const sessionFile = await evaluate(
      '(window.piMemeRemoteTestBridge ?? window.piMemeClient).getSnapshot().then(value => value.connection.sessionFile)',
    )
    assert.equal(typeof sessionFile, 'string')
    assert.match(await readFile(sessionFile as string, 'utf8'), /打包消息/)
    if (mode === 'remote') {
      await evaluate(`window.piPlatform.removeSavedHostConnection(${JSON.stringify(remoteHost!.url)})`)
      assert.deepEqual(await evaluate('window.piPlatform.listSavedHostConnections()'), [])
    }
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
    if (!existingRoot) await rm(root, { recursive: true, force: true })
  }
}

const cases = {
  local: '实际 macOS 应用启动独立 Host，加载共享 UI 并通过 Worker 完成假模型消息',
  recovery: '实际应用远程连接失败时保留本机界面并完成假模型消息',
  remote: '实际应用保持本机页面并经代理连接 HTTPS Host 完成假模型消息，退出不停止外部 Host',
} as const
for (const mode of ['local', 'recovery', 'remote'] as const)
  test(
    cases[mode],
    { skip: process.platform !== 'darwin' ? '实际应用验收只适用于 macOS' : false, timeout: 120000 },
    () => runPackagedSmoke(mode),
  )

test(
  '实际应用无模型凭据首次及再次启动均加载内置 Skill Creator，Host 令牌保持',
  { skip: process.platform !== 'darwin', timeout: 120000 },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pi-meme-package-fresh-'))
    try {
      await runPackagedSmoke('fresh', root)
      const file = path.join(root, 'userData', 'auth.json')
      const before = await readFile(file, 'utf8')
      await runPackagedSmoke('fresh', root)
      assert.equal(await readFile(file, 'utf8'), before)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)
