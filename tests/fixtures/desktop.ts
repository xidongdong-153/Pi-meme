import { test as base, expect, _electron, type ElectronApplication, type Page } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import type { DesktopBridge } from '@pi-meme/contracts/desktop'

declare global {
  interface Window {
    piMemeClient?: DesktopBridge
  }
}

interface DesktopFixture {
  app: ElectronApplication
  page: Page
  directory: string
  project: string
  runNative: (name: string) => Promise<void>
  selectProject: () => Promise<void>
  seedConversation: () => Promise<void>
}
type AgentMode = 'normal' | 'queue' | 'pause' | 'picker' | 'empty-models'
interface NativeTestGlobal {
  piMemeDesktopTest: {
    prepare: () => Promise<void>
    run: (name: string) => Promise<void>
    dispose: () => Promise<void>
  }
}

async function within<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`桌面测试等待超时：${label}`)), milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export const test = base.extend<{ desktop: DesktopFixture; agentMode: AgentMode }>({
  agentMode: ['normal', { option: true }],
  desktop: async ({ agentMode }, use, info) => {
    const temporary = await realpath(await mkdtemp(path.join(tmpdir(), 'pi-desktop-e2e-')))
    const directory = path.join(temporary, 'data')
    const project = path.join(temporary, 'project')
    const screenshots = info.outputPath('screenshots')
    await Promise.all(
      [
        directory,
        path.join(directory, 'desktop-cache'),
        path.join(directory, 'smoke-app/dist'),
        project,
        screenshots,
      ].map((file) => mkdir(file, { recursive: true })),
    )
    await mkdir(path.join(project, 'src'))
    await mkdir(path.join(project, 'reference-fixture'))
    await writeFile(path.join(project, 'README.md'), '# 验收项目\n')
    await writeFile(path.join(project, 'src/main.ts'), 'export const main = true\n')
    await writeFile(path.join(project, 'reference-fixture/中文 文件.ts'), 'export const value = 1\n')
    await writeFile(path.join(project, 'reference-fixture/nested-file.ts'), 'export const nested = true\n')
    await promisify(execFile)('git', ['init', '--quiet', project])
    await writeFile(
      path.join(directory, 'smoke-app/package.json'),
      JSON.stringify({
        name: '@pi-meme-fixtures/desktop-smoke',
        version: '1.0.0',
        type: 'module',
        piMeme: { sdkVersion: 2, agent: 'dist/agent.js' },
      }),
    )
    await build({
      entryPoints: ['tests/fixtures/smoke-app-agent.mjs'],
      outfile: path.join(directory, 'smoke-app/dist/agent.js'),
      bundle: true,
      platform: 'node',
      format: 'esm',
    })
    await writeFile(
      path.join(directory, 'auth.json'),
      JSON.stringify({
        ...(agentMode === 'empty-models'
          ? {}
          : { 'model-provider:fake': JSON.stringify({ credential: { type: 'api_key', key: 'test' } }) }),
        ...(agentMode === 'picker'
          ? { 'model-provider:picker-test': JSON.stringify({ credential: { type: 'api_key', key: 'test' } }) }
          : {}),
      }),
      { mode: 0o600 },
    )
    await writeFile(
      path.join(directory, 'settings.json'),
      JSON.stringify({ themeId: 'dark', defaultAccessMode: 'workspace-write', mcpEnabled: false }),
    )
    const config = path.join(temporary, 'config.json')
    await writeFile(
      config,
      JSON.stringify({
        directory,
        project,
        screenshots,
        agentOptions: {
          queueSmoke: agentMode === 'queue',
          pauseSmoke: agentMode === 'pause',
          picker: agentMode === 'picker',
          emptyModels: agentMode === 'empty-models',
        },
      }),
    )
    const desktopRoot = path.resolve('apps/desktop')
    const require = createRequire(path.join(desktopRoot, 'package.json'))
    let app: ElectronApplication | undefined
    const diagnostics: string[] = []
    try {
      app = await _electron.launch({
        executablePath: require('electron') as string,
        args: [path.join(desktopRoot, 'tests/fixtures/electron-fixture.cjs'), `--pi-test-config=${config}`],
        cwd: desktopRoot,
        env: {
          ...process.env,
          PI_MEME_DATA_ROOT: directory,
          PI_MEME_TEST_CREDENTIALS: 'file',
          PI_MEME_REMOTE_HOST: '',
          PI_MEME_TOKEN: '',
        },
      })
      app.process().stderr?.on('data', (chunk: Buffer) => diagnostics.push(chunk.toString()))
      app.context().setDefaultTimeout(10000)
      app.context().setDefaultNavigationTimeout(15000)
      const page = await app.firstWindow()
      await page.emulateMedia({ colorScheme: null })
      page.on('pageerror', (error) => diagnostics.push(error.stack ?? error.message))
      page.on('console', (message) => {
        if (message.type() === 'error') diagnostics.push(message.text())
      })
      await app.context().tracing.start({ screenshots: true, snapshots: true, sources: true })
      await expect(page.getByRole('combobox', { name: '消息', exact: true })).toBeVisible()
      await app.evaluate(async () => (globalThis as unknown as NativeTestGlobal).piMemeDesktopTest.prepare())
      const runNative = (name: string) =>
        app!.evaluate(
          async (_electron, value) => (globalThis as unknown as NativeTestGlobal).piMemeDesktopTest.run(value),
          name,
        )
      const selectProject = async () => {
        await page.evaluate(async (cwd) => {
          await window.piMemeClient!.chooseDirectory(cwd)
          const connection = await window.piMemeClient!.getConnection()
          await window.piMemeClient!.setModel(connection.sessionKey!, { provider: 'fake', id: 'first' })
        }, project)
        await expect(page.getByRole('combobox', { name: '消息', exact: true })).toHaveAttribute(
          'contenteditable',
          'true',
        )
      }
      const seedConversation = async () => {
        await selectProject()
        await page.evaluate(async () => {
          const bridge = window.piMemeClient!
          const connection = await bridge.getConnection()
          await bridge.prompt(connection.sessionKey!, '权限验收前置会话')
        })
        await expect
          .poll(() =>
            page.evaluate(async () => {
              const snapshot = await window.piMemeClient!.getSnapshot()
              return Boolean(snapshot.connection.sessionFile) && !snapshot.state.isStreaming
            }),
          )
          .toBe(true)
      }
      await use({ app, page, directory, project, runNative, selectProject, seedConversation })
    } finally {
      try {
        if (app) {
          if (info.status !== info.expectedStatus) {
            const page = app.windows()[0]
            await page?.screenshot({ path: info.outputPath('failed.png'), timeout: 5000 }).catch(() => {})
            await within(app.context().tracing.stop({ path: info.outputPath('trace.zip') }), 10000, '保存跟踪').catch(
              () => {},
            )
            await info.attach('errors.json', {
              body: JSON.stringify(info.errors, null, 2),
              contentType: 'application/json',
            })
            await info.attach('electron.log', { body: diagnostics.join('\n'), contentType: 'text/plain' })
            for (const file of await readdir(screenshots))
              if (file.endsWith('.png'))
                await info.attach(file, { path: path.join(screenshots, file), contentType: 'image/png' })
          } else await within(app.context().tracing.stop(), 10000, '结束跟踪').catch(() => {})
          await within(
            app.evaluate(async () => (globalThis as unknown as NativeTestGlobal).piMemeDesktopTest.dispose()),
            5000,
            '关闭模拟服务',
          ).catch(() => {})
          await within(app.close(), 10000, '关闭 Electron').catch((cause) => {
            app!.process().kill('SIGKILL')
            throw cause
          })
        }
      } finally {
        await rm(temporary, { recursive: true, force: true })
      }
    }
  },
})
