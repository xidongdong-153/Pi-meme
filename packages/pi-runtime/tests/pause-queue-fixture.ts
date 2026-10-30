import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { QueuedInput } from '@pi-meme/contracts/plan'
import type { PiEvent } from '@pi-meme/contracts/pi'
import { SdkSession, type RuntimePolicy } from '../src/sdk/session'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'

export async function fixture(
  reply: NonNullable<Parameters<typeof useFakeAgent>[1]>['reply'],
  configure?: (session: SdkSession) => void,
  policy: RuntimePolicy = {},
) {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-pause-queue-'))
  const fake = await useFakeAgent(directory, { reply })
  const config = JSON.parse(await readFile(fake.modelsFile, 'utf8'))
  config.providers.fake.models[0].input = ['text', 'image']
  await writeFile(fake.modelsFile, JSON.stringify(config))
  await writeFile(path.join(fake.agentDir, 'settings.json'), JSON.stringify({ images: { autoResize: false } }))
  const events: PiEvent[] = []
  let queue: QueuedInput[] = []
  const session = new SdkSession(
    directory,
    {
      connection: () => {},
      error: () => {},
      event: ({ event }) => {
        if (event.type === 'queue_update') queue = structuredClone([...event.steering, ...event.followUp])
        events.push(event as PiEvent)
      },
    },
    fake.runtimePaths,
    fake.credentials,
    undefined,
    policy,
  )
  configure?.(session)
  session.start(directory)
  await session.snapshot()
  await session.setModel({ provider: 'fake', id: 'first' })
  return {
    session,
    fake,
    events,
    queue: () => queue,
    dispose: async () => {
      await session.stopAndWait()
      await fake.dispose()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

export async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('等待运行状态超时')
    await delay(10)
  }
}
