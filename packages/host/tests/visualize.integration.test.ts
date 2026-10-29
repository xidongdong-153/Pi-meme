import { test, expect } from 'vitest'
import { mkdtemp, rm, realpath, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createHost } from '../src/service'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'
import type { HostApi, SubmissionReceipt } from '@pi-meme/contracts/app-host'

const key = () => ({ idempotencyKey: crypto.randomUUID() })
async function settled(api: HostApi, receipt: SubmissionReceipt) {
  for (let i = 0; i < 400; i++) {
    const current = await api.sessions.receipt(receipt.operationId)
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(current.status)) {
      expect(current.status, current.error).toBe('completed')
      return
    }
    await delay(25)
  }
  throw new Error('草图生成等待超时')
}
test('Plan 生成草图、读取、隔离会话、反馈上下文和重启恢复', { timeout: 30000 }, async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'host-visualize-')))
  let called = false
  const fake = await useFakeAgent(root, {
    reply: () => {
      if (called) return { text: '草图已保存' }
      called = true
      return {
        tool: {
          name: 'save_visualization',
          arguments: JSON.stringify({
            title: '计划预览',
            description: '模拟跳过',
            html: '<button>跳过</button>',
            initialState: { stage: 'ready' },
            controls: [
              {
                type: 'select',
                key: 'stage',
                label: '状态',
                options: [
                  { label: '等待', value: 'ready' },
                  { label: '跳过', value: 'skipped' },
                ],
              },
            ],
          }),
        },
      }
    },
  })
  let host = await createHost({ dataRoot: fake.runtimePaths.dataRoot, credentials: fake.credentials })
  try {
    const project = await host.app.projects.register({ cwd: root }, key())
    const session = await host.app.sessions.create(
      { project, configuration: { model: { provider: 'fake', id: 'first' }, mode: 'plan', accessMode: 'full-access' } },
      key(),
    )
    const receipt = await host.app.sessions.submit(
      session,
      { text: '生成交互草图', mode: 'plan', delivery: 'start' },
      key(),
    )
    await settled(host.app, receipt)
    const documents = await host.app.visualizations!.list(session)
    expect(
      documents,
      JSON.stringify((await host.app.sessions.history(session)).messages.filter((m) => m.role === 'toolResult')),
    ).toHaveLength(1)
    const reference = { id: documents[0].id, revision: documents[0].revision }
    expect((await host.app.visualizations!.get(session, reference)).html).toContain('跳过')
    const other = await host.app.sessions.create({ project }, key())
    await expect(host.app.visualizations!.get(other, reference)).rejects.toThrow()
    await expect(
      host.app.sessions.submit(
        session,
        { text: '修改', delivery: 'start', mode: 'plan', visualization: { reference, state: { stage: 'invalid' } } },
        key(),
      ),
    ).rejects.toThrow()
    await settled(
      host.app,
      await host.app.sessions.submit(
        session,
        {
          text: '调整已选中的草图',
          delivery: 'start',
          mode: 'plan',
          visualization: { reference, state: { stage: 'skipped' } },
        },
        key(),
      ),
    )
    await host.dispose()
    host = await createHost({ dataRoot: fake.runtimePaths.dataRoot, credentials: fake.credentials })
    expect((await host.app.visualizations!.get(session, reference)).title).toBe('计划预览')
  } finally {
    await host.dispose()
    await fake.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('临时会话的草图仅存入临时目录，关闭后清除', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'temporary-visualize-'))
  const marker = '临时草图存储隔离验证'
  let called = false
  const fake = await useFakeAgent(root, {
    reply: () => {
      if (called) return { text: '已完成' }
      called = true
      return {
        tool: {
          name: 'save_visualization',
          arguments: JSON.stringify({
            title: marker,
            description: '临时预览',
            html: '<p>临时草图</p>',
            initialState: {},
            controls: [],
          }),
        },
      }
    },
  })
  const host = await createHost({ dataRoot: fake.runtimePaths.dataRoot, credentials: fake.credentials })
  const rpc = async (method: string, args: unknown[] = [], sessionId?: string) => {
    const response = await host.rpc({
      requestId: crypto.randomUUID(),
      clientId: 'visualize-owner',
      method,
      args,
      sessionId,
    })
    expect(response.error).toBeUndefined()
    return response.result
  }
  async function matches(directory: string): Promise<string[]> {
    const result: string[] = []
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name)
      if (item.isDirectory()) result.push(...(await matches(file)))
      else if ((await readFile(file)).includes(Buffer.from(marker))) result.push(file)
    }
    return result
  }
  try {
    const source = (await rpc('pi:snapshot')) as import('@pi-meme/contracts/desktop').Snapshot
    const opened = (await rpc(
      'temporary-session:open',
      [{ sourceSessionKey: source.connection.sessionKey }],
      source.connection.sessionKey!,
    )) as import('@pi-meme/contracts/desktop').Snapshot
    const sessionKey = opened.connection.sessionKey!
    await rpc('pi:prompt', [sessionKey, '创建草图', [], [], { mode: 'plan' }], sessionKey)
    let documents: unknown[] = []
    for (let i = 0; i < 400; i++) {
      const response = await host.control.dispatch({
        apiVersion: 2,
        hostId: host.hostId,
        clientId: 'visualize-owner',
        method: 'visualizations.list',
        args: [opened.appSession],
      })
      expect(response.error).toBeUndefined()
      documents = response.result as unknown[]
      const snapshot = (await rpc('pi:snapshot', [], sessionKey)) as import('@pi-meme/contracts/desktop').Snapshot
      if (documents.length && !snapshot.state.isStreaming) break
      await delay(25)
    }
    expect(documents).toHaveLength(1)
    const files = await matches(fake.runtimePaths.dataRoot)
    expect(files.length).toBeGreaterThan(0)
    expect(
      files.every((file) => file.includes(`${path.sep}temporary-sessions${path.sep}`)),
      files.join('\n'),
    ).toBe(true)
    await rpc('temporary-session:close', [sessionKey], sessionKey)
    expect(await matches(fake.runtimePaths.dataRoot)).toEqual([])
  } finally {
    await host.dispose()
    await fake.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
