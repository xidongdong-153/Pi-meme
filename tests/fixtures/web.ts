import { test as base, expect, type Page } from '@playwright/test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startHostServer } from '@pi-meme/host/server'
import { useFakeAgent } from './fake-agent.mjs'
import { requestText } from './fake-provider.mjs'
import type { DesktopBridge } from '@pi-meme/contracts/desktop'

declare global {
  interface Window {
    piMemeClient?: DesktopBridge
  }
}

interface WebFixture {
  url: string
  root: string
  server: Awaited<ReturnType<typeof startHostServer>>
  releaseReply: () => void
}

export const test = base.extend<{ host: WebFixture }>({
  baseURL: async ({ host }, use) => {
    await use(host.url)
  },
  // eslint-disable-next-line no-empty-pattern -- Host fixture 不依赖浏览器，Playwright 要求解构首个参数。
  host: async ({}, use) => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'pi-web-e2e-')))
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const fake = await useFakeAgent(root, {
      reply: (body) =>
        requestText(body).includes('等待停止')
          ? { text: '正在等待停止操作', finishBarrier: barrier }
          : { text: '本地模型完整回复', thinking: '检查当前输入', chunkDelayMs: 2 },
    })
    let server: Awaited<ReturnType<typeof startHostServer>> | undefined
    try {
      server = await startHostServer({
        dataRoot: fake.runtimePaths.dataRoot,
        credentials: fake.credentials,
        token: 'test-token',
        localAutoLogin: true,
        staticDirectory: path.resolve('apps/web/dist'),
      })
      await use({ url: server.url, root, server, releaseReply: release })
    } finally {
      release()
      await server?.dispose()
      await fake.dispose()
      await rm(root, { recursive: true, force: true })
    }
  },
})

export async function openChat(page: Page, url: string) {
  await page.goto(url)
  await expect(page.getByRole('combobox', { name: '消息', exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(() => Boolean(window.piMemeClient))).toBe(true)
  await page.evaluate(async () => {
    const bridge = window.piMemeClient!
    const snapshot = await bridge.getSnapshot()
    if (!snapshot.state.model) await bridge.setModel(snapshot.connection.sessionKey!, { provider: 'fake', id: 'first' })
  })
  await expect(page.getByRole('combobox', { name: '消息', exact: true })).toHaveAttribute('contenteditable', 'true')
}
