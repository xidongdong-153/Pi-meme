import { test, expect, _electron, type ElectronApplication } from '@playwright/test'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'
import type { DesktopBridge } from '@pi-meme/contracts/desktop'

test('常规设置通过真实维护进程迁移、重新启动、清理缓存并保留会话', async () => {
  test.setTimeout(180000)
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'pi-meme-storage-e2e-')))
  const home = path.join(directory, 'home')
  const source = path.join(home, '.pi-meme')
  const target = path.join(directory, 'custom-profile')
  const anchor = path.join(directory, 'desktop')
  await Promise.all([path.join(source, 'pi'), target, anchor].map((folder) => mkdir(folder, { recursive: true })))
  const agent = await useFakeAgent(path.join(directory, 'model'), {
    reply: () => ({ text: '迁移验收回复', delayMs: 50 }),
  })
  await writeFile(path.join(source, 'pi/models.json'), await readFile(agent.modelsFile))
  await writeFile(path.join(source, 'auth.json'), JSON.stringify(Object.fromEntries(agent.credentials.entries())), {
    mode: 0o600,
  })
  const desktop = path.resolve('apps/desktop')
  const require = createRequire(path.join(desktop, 'package.json'))
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    HOME: home,
    PI_MEME_PORT: '0',
    PI_MEME_STORAGE_TEST_TARGET: target,
    PI_MEME_REMOTE_HOST: '',
    PI_MEME_TOKEN: '',
  }
  delete env.PI_MEME_DATA_ROOT
  delete env.PI_MEME_TEST_CREDENTIALS
  let app: ElectronApplication | undefined
  const output: string[] = []
  async function launch() {
    app = await _electron.launch({
      executablePath: require('electron') as string,
      args: [path.join(desktop, 'tests/fixtures/storage-fixture.cjs'), `--user-data-dir=${anchor}`],
      cwd: desktop,
      env,
    })
    app.process().stderr?.on('data', (chunk: Buffer) => output.push(chunk.toString()))
    return app
  }
  async function page() {
    const current = await app!.firstWindow()
    await expect(current.getByRole('combobox', { name: '消息', exact: true })).toBeVisible()
    return current
  }
  async function applyPending() {
    const current = await launch()
    if (current.process().exitCode === null) await once(current.process(), 'exit')
    expect(JSON.parse(await readFile(path.join(anchor, 'storage-location.json'), 'utf8')).pending).toBeUndefined()
    app = undefined
  }
  try {
    await launch()
    let current = await page()
    await current.evaluate(async () => {
      const bridge = (window as Window & { piMemeClient: DesktopBridge }).piMemeClient
      const connection = await bridge.getConnection()
      await bridge.setModel(connection.sessionKey!, { provider: 'fake', id: 'first' })
      await bridge.prompt(connection.sessionKey!, '迁移前的会话')
    })
    await expect(current.getByText('迁移验收回复', { exact: true })).toBeVisible()
    const originalHost = await current.evaluate(() => window.piMemeClient!.getStorageInfo())
    const saved = await current.evaluate(async () => (await window.piMemeClient!.getSessions()).recents)
    expect(saved.length).toBeGreaterThan(0)
    await current.getByRole('button', { name: '设置', exact: true }).click()
    await expect(current.getByTestId('storage-root')).toHaveText(source)
    await current.getByRole('button', { name: '更改目录' }).click()
    await expect(current.getByRole('dialog')).toContainText(target)
    const exited = once(app!.process(), 'exit')
    await current.getByRole('button', { name: '迁移并重启', exact: true }).click()
    await exited
    app = undefined
    await applyPending()
    await launch()
    current = await page()
    const movedHost = await current.evaluate(() => window.piMemeClient!.getStorageInfo())
    expect(movedHost).toEqual({ hostId: originalHost.hostId, dataRoot: target })
    const moved = await current.evaluate(() => window.piMemeClient!.getSessions())
    expect(moved.recents.map((entry) => entry.path)).toContainEqual(
      expect.stringContaining(path.basename(saved[0].path)),
    )
    expect(moved.recents.every((entry) => entry.path.startsWith(target))).toBe(true)
    await current.getByRole('button', { name: '设置', exact: true }).click()
    await expect(current.getByTestId('storage-root')).toHaveText(target)
    await expect(current.getByRole('region', { name: '迁移备份' })).toContainText(source)
    await writeFile(path.join(target, 'remote-services.json'), '[]')
    await current.getByRole('button', { name: '刷新', exact: true }).click()
    await expect(current.getByRole('button', { name: '清理缓存', exact: true })).toBeEnabled()
    await current.getByRole('button', { name: '清理缓存', exact: true }).click()
    const cleared = once(app!.process(), 'exit')
    await current.getByRole('button', { name: '清理并重启', exact: true }).click()
    await cleared
    app = undefined
    await applyPending()
    await launch()
    current = await page()
    const final = await current.evaluate(() => window.piMemeClient!.getSessions())
    expect(final.recents.map((entry) => entry.path)).toContainEqual(
      expect.stringContaining(path.basename(saved[0].path)),
    )
    expect(await readFile(path.join(target, 'auth.json'), 'utf8')).toContain('model-provider:fake')
    expect(await readFile(path.join(source, '.pi-meme-relocated.json'), 'utf8')).toContain(target)
  } catch (cause) {
    throw new Error(`存储端到端验收失败：${output.join('').slice(-16000)}`, { cause })
  } finally {
    await app?.close().catch(() => app?.process().kill('SIGKILL'))
    await agent.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
