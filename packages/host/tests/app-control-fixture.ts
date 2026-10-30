import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { HostApi, SubmissionReceipt } from '@pi-meme/contracts/app-host'
import { createHost } from '../src/service'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'

type FakeReply = NonNullable<Parameters<typeof useFakeAgent>[1]>['reply']
export async function fixture(reply?: FakeReply) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'pi-app-control-')))
  const fake = await useFakeAgent(root, { reply })
  const dataRoot = fake.runtimePaths.dataRoot
  let host = await createHost({ dataRoot, credentials: fake.credentials })
  return {
    root,
    fake,
    dataRoot,
    get host() {
      return host
    },
    async restart() {
      await host.dispose()
      host = await createHost({ dataRoot, credentials: fake.credentials })
      return host
    },
    async dispose() {
      await host.dispose()
      await fake.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}
export const key = (idempotencyKey: string) => ({ idempotencyKey })
export async function eventually<T>(read: () => Promise<T>, ready: (value: T) => boolean, timeout = 12000): Promise<T> {
  const deadline = Date.now() + timeout
  let value = await read()
  while (!ready(value)) {
    if (Date.now() > deadline) throw new Error(`控制协议等待超时：${JSON.stringify(value)}`)
    await delay(10)
    value = await read()
  }
  return value
}
export function finished(receipt: SubmissionReceipt) {
  return ['completed', 'failed', 'interrupted', 'cancelled'].includes(receipt.status)
}
export async function session(api: HostApi, project: import('@pi-meme/contracts/app-host').ProjectRef, name: string) {
  return api.sessions.create(
    { project, name, configuration: { model: { provider: 'fake', id: 'first' }, accessMode: 'full-access' } },
    key(`create-${name}`),
  )
}
