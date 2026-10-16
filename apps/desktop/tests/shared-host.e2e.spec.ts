import { test, expect, _electron, type ElectronApplication } from '@playwright/test'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { startHostServer } from '@pi-meme/host/server'
import { readLocalHostStatus } from '@pi-meme/host/host-status'
import type { PlatformAdapter } from '@pi-meme/contracts/host'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'

async function freePort() {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('共享验收端口不可用')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

for (const owner of ['server', 'desktop'] as const) {
  test(`${owner === 'server' ? 'Server' : 'Desktop'} 先启动，Desktop 和浏览器共用一个 Host，退出遵循所有权`, async ({
    browser,
  }) => {
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'pi-desktop-shared-')))
    let replies = 0
    const fake = await useFakeAgent(directory, { reply: () => ({ text: `共享模型回复 ${++replies}`, delayMs: 100 }) })
    const dataRoot = fake.runtimePaths.dataRoot
    const project = path.join(directory, 'project')
    const otherProject = path.join(directory, 'other-project')
    await Promise.all([project, otherProject].map((folder) => mkdir(folder)))
    await writeFile(path.join(dataRoot, 'auth.json'), JSON.stringify(Object.fromEntries(fake.credentials.entries())), {
      mode: 0o600,
    })
    let server: Awaited<ReturnType<typeof startHostServer>> | undefined
    if (owner === 'server')
      server = await startHostServer({ dataRoot, credentials: fake.credentials, localAutoLogin: true })
    const port = server ? Number(new URL(server.url).port) : await freePort()
    const backendUrl = `http://127.0.0.1:${port}`
    const desktop = path.resolve('apps/desktop')
    const require = createRequire(path.join(desktop, 'package.json'))
    const env = {
      ...process.env,
      PI_MEME_DATA_ROOT: dataRoot,
      PI_MEME_PORT: String(port),
      PI_MEME_TEST_CREDENTIALS: 'file',
      PI_MEME_REMOTE_HOST: '',
      PI_MEME_TOKEN: '',
      PI_DESKTOP_DEV_SERVER_URL: '',
    }
    let app: ElectronApplication | undefined
    const context = await browser.newContext()
    const output: string[] = []
    async function launch() {
      app = await _electron.launch({
        executablePath: require('electron') as string,
        args: [path.join(desktop, '.vite/build/main.js')],
        cwd: desktop,
        env,
      })
      app.process().stderr?.on('data', (chunk: Buffer) => output.push(chunk.toString()))
      const page = await app.firstWindow()
      await expect(page.getByRole('combobox', { name: '消息', exact: true })).toBeVisible()
      return page
    }
    try {
      const page = await launch()
      const status = await readLocalHostStatus(backendUrl)
      expect(status?.owner).toBe(owner)
      expect(
        await app!.evaluate(({ app }) => app.getAppMetrics().filter((metric) => metric.name === 'Pi Meme Host').length),
      ).toBe(owner === 'desktop' ? 1 : 0)
      const web = await context.newPage()
      await web.goto(page.url())
      await expect(web.getByRole('combobox', { name: '消息', exact: true })).toBeVisible()
      const ids = await Promise.all(
        [page, web].map((surface) =>
          surface.evaluate(async () => {
            const response = await fetch('/api/status')
            return response.json() as Promise<{ hostId: string; instanceId: string }>
          }),
        ),
      )
      expect(ids[0]).toEqual(ids[1])
      expect(ids[0].hostId).toBe(status!.hostId)
      await page.evaluate(async (cwd) => {
        const bridge = window.piMemeClient!
        await bridge.chooseDirectory(cwd)
        const connection = await bridge.getConnection()
        await bridge.setModel(connection.sessionKey!, { provider: 'fake', id: 'first' })
        await bridge.prompt(connection.sessionKey!, '共享首条消息')
      }, project)
      await expect(page.getByText('共享模型回复 1', { exact: true })).toBeVisible()
      const selected = await page.evaluate(() => window.piMemeClient!.getConnection())
      expect(selected.sessionFile).toBeTruthy()
      await web.evaluate((file) => window.piMemeClient!.switchSession(file), selected.sessionFile!)
      await expect(web.getByText('共享模型回复 1', { exact: true })).toBeVisible()
      await page.evaluate(async () => {
        const bridge = window.piMemeClient!
        const connection = await bridge.getConnection()
        await bridge.prompt(connection.sessionKey!, '共享流式消息')
      })
      await expect(page.getByText('共享模型回复 2', { exact: true })).toBeVisible()
      await expect(web.getByText('共享模型回复 2', { exact: true })).toBeVisible()
      expect(fake.provider.requests).toHaveLength(2)
      await web.evaluate((cwd) => window.piMemeClient!.chooseDirectory(cwd), otherProject)
      expect((await page.evaluate(() => window.piMemeClient!.getConnection())).cwd).toBe(project)
      expect((await web.evaluate(() => window.piMemeClient!.getConnection())).cwd).toBe(otherProject)
      if (owner === 'server') {
        const native = await page.evaluate(async (hostId) => {
          const platform = (window as Window & { piPlatform: PlatformAdapter }).piPlatform
          return platform.storage!.getInfo(hostId)
        }, status!.hostId)
        expect(native.canMaintain).toBe(false)
        expect(native.maintenanceDisabledReason).toContain('其他入口管理')
        const denied = await page.evaluate(async (hostId) => {
          try {
            await (window as Window & { piPlatform: PlatformAdapter }).piPlatform.storage!.clearCache(hostId)
            return ''
          } catch (cause) {
            return String(cause)
          }
        }, status!.hostId)
        expect(denied).toContain('其他入口管理')
      } else {
        const secondaryEnv: NodeJS.ProcessEnv = { ...env }
        for (const key of ['PI_MEME_TOKEN', 'PI_MEME_TLS_CERT', 'PI_MEME_TLS_KEY', 'PI_MEME_WEB_ROOT'])
          delete secondaryEnv[key]
        const child = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/main.ts'], {
          cwd: path.resolve('.'),
          env: secondaryEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let secondaryOutput = ''
        child.stdout.on('data', (chunk: Buffer) => {
          secondaryOutput += chunk.toString()
        })
        child.stderr.on('data', (chunk: Buffer) => {
          secondaryOutput += chunk.toString()
        })
        const code = await new Promise<number | null>((resolve, reject) => {
          const timer = setTimeout(() => {
            child.kill('SIGTERM')
            reject(new Error('第二个 Server 入口未退出'))
          }, 10000)
          child.once('error', (cause) => {
            clearTimeout(timer)
            reject(cause)
          })
          child.once('exit', (code) => {
            clearTimeout(timer)
            resolve(code)
          })
        })
        expect(code, secondaryOutput).toBe(0)
        expect(secondaryOutput).toContain('复用已有 Host')
        expect((await readLocalHostStatus(backendUrl))?.instanceId).toBe(status!.instanceId)
      }
      await context.close()
      await app!.close()
      app = undefined
      if (owner === 'server') {
        expect((await readLocalHostStatus(backendUrl))?.instanceId).toBe(status!.instanceId)
        await launch()
        await server!.dispose()
        await delay(500)
        expect(await readLocalHostStatus(backendUrl)).toBeUndefined()
      } else expect(await readLocalHostStatus(backendUrl)).toBeUndefined()
    } catch (cause) {
      throw new Error(`共享 Host 验收失败：${String(cause)}\n${output.join('')}`, { cause })
    } finally {
      await context.close()
      await app?.close()
      await server?.dispose()
      await fake.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })
}
