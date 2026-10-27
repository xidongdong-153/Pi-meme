import { fork } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, cp } from 'node:fs/promises'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

const workspace = process.cwd()
const [mode, requestedRoot = workspace] = process.argv.slice(2)
const sourceRoot = path.resolve(requestedRoot)
const output = path.join(workspace, 'out/session-performance')
if (mode === 'host') {
  const config = JSON.parse(await readFile(process.argv[4], 'utf8'))
  const { startHostServer } = await import(pathToFileURL(path.join(sourceRoot, 'packages/host/src/server.ts')).href)
  const { MemoryCredentialStorage } = await import(
    pathToFileURL(path.join(sourceRoot, 'packages/pi-runtime/src/secure-store.ts')).href
  )
  const credentials = new MemoryCredentialStorage()
  for (const [key, value] of config.credentials) credentials.set(key, value)
  const server = await startHostServer({
    dataRoot: config.dataRoot,
    credentials,
    builtinSkillsSource: config.builtinSkillsSource,
    token: 'benchmark-only',
    localAutoLogin: true,
  })
  process.send!({ ready: server.url })
  let cpu = process.cpuUsage()
  process.on('message', async (message: any) => {
    if (message.method === 'start') {
      cpu = process.cpuUsage()
      process.send!({ id: message.id })
    }
    if (message.method === 'cpu') {
      const result = process.cpuUsage(cpu)
      process.send!({ id: message.id, cpuMs: (result.user + result.system) / 1000, rss: process.memoryUsage().rss })
    }
    if (message.method === 'stop') {
      await server.dispose()
      process.exit(0)
    }
  })
  process.on('SIGTERM', () => {
    void server.dispose().finally(() => process.exit())
  })
} else {
  const label = mode ?? 'current'
  const { useFakeAgent } = await import(pathToFileURL(path.join(workspace, 'tests/fixtures/fake-agent.mjs')).href)
  const { chromium } = await import('@playwright/test')
  const { createServer } = await import('vite')
  await mkdir(output, { recursive: true })
  const root = await mkdtemp(path.join(output, `${label}-runtime-`))
  let release = () => {}
  let gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const body = '并行输出检查正文，验证字符完整与更新性能。'.repeat(Number(process.env.PI_BENCH_TEXT_REPEATS ?? 1200))
  const text = process.env.PI_BENCH_CODE === '1' ? ['```text', body, '```'].join('\n') : body
  const fake = await useFakeAgent(root, { reply: () => ({ text, chunkDelayMs: 2, startBarrier: gate }) })
  const configFile = path.join(root, 'fixture.json')
  const builtinSkillsSource = path.join(root, 'fixture-skills')
  await mkdir(builtinSkillsSource)
  await cp(path.join(workspace, 'pi/skills/skill-creator'), path.join(builtinSkillsSource, 'skill-creator'), {
    recursive: true,
  })
  await writeFile(
    configFile,
    JSON.stringify({
      dataRoot: fake.runtimePaths.dataRoot,
      credentials: fake.credentials.entries(),
      builtinSkillsSource,
    }),
  )
  const child = fork(fileURLToPath(import.meta.url), ['host', sourceRoot, configFile], {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  child.stdout?.on('data', (data) => process.stderr.write(data))
  child.stderr?.on('data', (data) => process.stderr.write(data))
  let vite: Awaited<ReturnType<typeof createServer>> | undefined
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  const pending = new Map<string, (value: any) => void>()
  const ready = new Promise<string>((resolve, reject) => {
    child.on('message', (message: any) => {
      if (message.ready) resolve(message.ready)
      if (message.id) {
        pending.get(message.id)?.(message)
        pending.delete(message.id)
      }
    })
    child.once('exit', (code) => reject(new Error(`Host 退出 ${code}`)))
  })
  const call = (method: string) =>
    new Promise<any>((resolve) => {
      const id = crypto.randomUUID()
      pending.set(id, resolve)
      child.send({ id, method })
    })
  const until = async (predicate: () => Promise<boolean> | boolean, label: string, timeout = 60000) => {
    const end = Date.now() + timeout
    while (!(await predicate())) {
      if (Date.now() > end) throw new Error(`${label} 超时`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  try {
    const url = await ready
    process.env.PI_MEME_HOST_URL = url
    vite = await createServer({
      configFile: path.join(sourceRoot, 'apps/web/vite.config.ts'),
      root: path.join(sourceRoot, 'apps/web'),
      cacheDir: path.join(root, 'vite-cache'),
      server: { host: '127.0.0.1', port: 0, strictPort: false, fs: { allow: [workspace, sourceRoot] } },
      logLevel: 'warn',
    })
    await vite.listen()
    const address = vite.httpServer!.address() as { port: number }
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    const page = await context.newPage()
    // tsx 的函数命名辅助方法在页面序列化后仍会被引用。
    await page.addInitScript('window.__name = (fn) => fn')
    const browserErrors: string[] = []
    page.on('pageerror', (error) => {
      browserErrors.push(error.message)
      console.error('浏览器错误', error.message)
    })
    page.on('console', (message) => {
      if (message.type() === 'error') browserErrors.push(message.text())
    })
    await page.goto(`http://127.0.0.1:${address.port}`)
    await page.waitForFunction(() => Boolean((window as any).piMemeClient), { timeout: 60000 })
    await page.getByRole('combobox', { name: '消息', exact: true }).waitFor({ timeout: 60000 })
    const cdp = await context.newCDPSession(page)
    await cdp.send('Performance.enable')
    const metrics = async () =>
      (await cdp.send('Performance.getMetrics')).metrics.find((entry: any) => entry.name === 'TaskDuration')!.value
    const results: any[] = []
    for (const count of [1, 4, 8]) {
      gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const requestsBefore = fake.provider.requests.length
      const startup = performance.now()
      await page.evaluate(() => {
        const state = { keys: [] as string[], settled: [] as string[], updates: 0, errors: [] as string[] }
        ;(window as any).__bench = state
        ;(window as any).__benchOff?.()
        ;(window as any).__benchOff = (window as any).piMemeClient.onEvent((record: any) => {
          if (!state.keys.includes(record.sessionKey)) return
          if (record.event.type === 'message_update') state.updates++
          if (record.event.type === 'agent_settled') state.settled = [...new Set([...state.settled, record.sessionKey])]
        })
      })
      for (let index = 0; index < count; index++) {
        await page.evaluate(async (index) => {
          const bridge = (window as any).piMemeClient
          const result = await bridge.newSession()
          const key = result.snapshot.connection.sessionKey
          ;(window as any).__bench.keys.push(key)
          void bridge
            .prompt(key, `并行基准 ${index}`)
            .catch((error: Error) => (window as any).__bench.errors.push(error.message))
        }, index)
        await until(
          async () =>
            fake.provider.requests.length > requestsBefore + index ||
            (await page.evaluate(() => (window as any).__bench.errors.length > 0)),
          'Worker 启动',
        )
        const errors = await page.evaluate(() => (window as any).__bench.errors)
        if (errors.length) throw new Error(errors.join('; '))
      }
      if (process.env.PI_BENCH_BACKGROUND === '1') await page.evaluate(() => (window as any).piMemeClient.newSession())
      const startupMs = performance.now() - startup
      await call('start')
      const rendererBefore = await metrics()
      const start = performance.now()
      release()
      await until(
        () => page.evaluate((count) => (window as any).__bench.settled.length >= count, count),
        '并行输出结束',
      )
      const elapsedMs = performance.now() - start
      const cpu = await call('cpu')
      const rendererCpuMs = ((await metrics()) - rendererBefore) * 1000
      const state = await page.evaluate(() => (window as any).__bench)
      results.push({
        count,
        elapsedMs,
        startupMs,
        hostCpuMs: cpu.cpuMs,
        rendererCpuMs,
        updates: state.updates,
        hostRss: cpu.rss,
        errors: state.errors,
        browserErrors: [...new Set(browserErrors)],
      })
      console.log(JSON.stringify({ label, ...results.at(-1) }))
      await writeFile(path.join(output, `${label}-runtime.json`), JSON.stringify(results, null, 2))
    }
    await until(
      () =>
        page
          .getByLabel('会话运行中', { exact: true })
          .count()
          .then((count) => count === 0),
      '侧栏状态完成',
      30000,
    )
    if (label.startsWith('current')) {
      const choices = await page.locator('[data-session-path]').evaluateAll((elements) =>
        elements
          .filter((element) => element.textContent?.includes('并行基准'))
          .slice(0, 3)
          .map((element) => ({ path: element.getAttribute('data-session-path')!, title: element.textContent!.trim() })),
      )
      const switchSamples: Array<{ visible: number; ready: number; previewReadOnly: boolean }> = []
      for (let index = 0; index < 33; index++) {
        const target = choices[(index + 1) % choices.length]
        const measurement = await page.evaluate(async ({ path, title }) => {
          const row = [...document.querySelectorAll('[data-session-path]')].find(
            (entry) => entry.getAttribute('data-session-path') === path,
          )!
          const button = row.querySelector('button')!
          const start = performance.now()
          button.click()
          const wait = (predicate: () => boolean) =>
            new Promise<void>((resolve, reject) => {
              const check = () => {
                if (predicate()) return resolve()
                if (performance.now() - start > 10000) return reject(new Error('切换未完成'))
                requestAnimationFrame(check)
              }
              check()
            })
          await wait(() =>
            [...document.querySelectorAll('[aria-label="对话消息流"]')].some(
              (entry) => entry.getClientRects().length > 0 && entry.textContent?.includes(title),
            ),
          )
          const visible = performance.now() - start
          const synchronizing = [...document.querySelectorAll('[role="status"]')].some((entry) =>
            entry.textContent?.includes('同步'),
          )
          const previewReadOnly =
            !synchronizing || document.querySelector('[aria-label="消息"][contenteditable="true"]') === null
          await wait(
            () =>
              ![...document.querySelectorAll('[role="status"]')].some((entry) => entry.textContent?.includes('同步')) &&
              document.querySelector('[aria-label="消息"][contenteditable="true"]') !== null,
          )
          return { visible, ready: performance.now() - start, previewReadOnly }
        }, target)
        if (index >= 3) switchSamples.push(measurement)
      }
      const sorted = (key: 'visible' | 'ready') => switchSamples.map((sample) => sample[key]).sort((a, b) => a - b)
      const switches = {
        samples: switchSamples,
        visibleP95: sorted('visible')[Math.floor(switchSamples.length * 0.95)],
        readyP95: sorted('ready')[Math.floor(switchSamples.length * 0.95)],
        panes: await page.locator('[data-session-pane]').count(),
        previewReadOnly: switchSamples.every((sample) => sample.previewReadOnly),
        browserErrors: [...new Set(browserErrors)],
      }
      console.log(JSON.stringify({ label, switches }))
      await writeFile(path.join(output, `${label}-switches.json`), JSON.stringify(switches, null, 2))
    }
    await page.screenshot({ path: path.join(output, `${label}-desktop.png`) })
    if (label.startsWith('current')) {
      await page.setViewportSize({ width: 430, height: 920 })
      await page.getByRole('button', { name: '收起侧边栏', exact: true }).click()
      await page.waitForFunction(() => document.querySelector('#workspace-sidebar') === null)
      await page.screenshot({ path: path.join(output, `${label}-narrow.png`) })
    }
    await writeFile(path.join(output, `${label}-runtime.json`), JSON.stringify(results, null, 2))
  } finally {
    release()
    await browser?.close()
    await vite?.close()
    if (child.connected) child.send({ method: 'stop' })
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve()
      child.once('exit', () => resolve())
      setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 10000).unref()
    })
    await fake.dispose()
  }
}
