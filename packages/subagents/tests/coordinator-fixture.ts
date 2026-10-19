import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createHostCollaborationBridge } from '../src/server/coordinator'
import type { RuntimeSdkSession } from '@pi-meme/pi-runtime/session-pool'
import type { DesktopEvent, Snapshot } from '@pi-meme/contracts/desktop'
import type { CollaborationRequest, AgentSummary } from '@pi-meme/contracts/collaboration'
import type { TaskMode } from '@pi-meme/contracts/plan'
import type { SdkSession } from '@pi-meme/pi-runtime/sdk/session'

type Notify = ConstructorParameters<typeof SdkSession>[1]

function fakeSession(
  cwd: string,
  notify: Notify,
  complete?: (session: RuntimeSdkSession, report: string) => Promise<unknown>,
) {
  const sessionId = randomUUID()
  const state: Snapshot['state'] = {
    mode: 'default',
    isStreaming: false,
    isCompacting: false,
    steeringMode: 'all',
    followUpMode: 'one-at-a-time',
    pendingMessageCount: 0,
  }
  const messages: Snapshot['messages'] = []
  const prompts: string[] = []
  const delivered: string[] = []
  const continuations: string[] = []
  const faults: {
    continuation?: boolean
    deliveryGate?: Promise<void>
    deliveryStarted?: () => void
    snapshotGate?: Promise<void>
    pauseGate?: Promise<void>
  } = {}
  const pauses: Array<{ paused: boolean; revision: number }> = []
  let pauseRevision = -1
  let status: Snapshot['connection']['status'] = 'idle'
  const session = {
    setPaused: async (paused: boolean, revision: number) => {
      if (revision > pauseRevision) {
        pauseRevision = revision
        state.isPaused = paused
      }
      pauses.push({ paused, revision })
      await faults.pauseGate
    },
    configureAccess: () => {},
    configureAgentTask: async () => {},
    configureCapabilities: () => {},
    configureInlineExtensions: () => {},
    start: () => {
      status = 'ready'
    },
    connection: () => ({ cwd, generation: 1, status }),
    getActiveSession: () => ({ sessionId }),
    setSessionMode: async (mode: TaskMode) => {
      state.mode = mode
    },
    setModel: async (model: Snapshot['state']['model']) => {
      state.model = model
      return model
    },
    setThinkingLevel: async (level: Snapshot['state']['thinkingLevel']) => {
      state.thinkingLevel = level
    },
    prompt: async (message: string) => {
      prompts.push(message)
      state.isStreaming = true
    },
    continueCollaborationTask: async (message: string) => {
      if (faults.continuation) throw new Error('准入失败')
      continuations.push(message)
      state.isStreaming = true
    },
    deliverCollaborationMessage: async (message: { id: string; text?: string }) => {
      faults.deliveryStarted?.()
      await faults.deliveryGate
      if (!delivered.includes(message.id)) {
        delivered.push(message.id)
        notify.event({
          generation: 1,
          event: {
            type: 'message_end',
            message: {
              role: 'custom',
              customType: 'pi-meme-collaboration',
              content: message.text ?? '',
              display: true,
              details: { messageId: message.id },
              timestamp: Date.now(),
            },
          },
        })
      }
      return { persisted: true }
    },
    snapshot: async () => {
      await faults.snapshotGate
      return {
        connection: { cwd, generation: 1, status },
        state: { ...state },
        messages: messages.slice(),
        models: [],
      }
    },
    getEntries: async () => ({ entries: [], leafId: null }),
    abort: async () => {
      state.isPaused = false
      state.isStreaming = false
    },
    stopAndWait: async () => {
      status = 'disconnected'
    },
  } as unknown as RuntimeSdkSession
  const reply = (text: string) => {
    messages.push({
      role: 'assistant',
      content: [{ type: 'text', text }],
      timestamp: Date.now(),
    } as Snapshot['messages'][number])
    state.isStreaming = false
    notify.event({ generation: 1, event: { type: 'agent_settled' } })
  }
  const finish = async (text: string) => {
    if (complete) await complete(session, text)
    reply(text)
  }
  return { session, finish, reply, prompts, delivered, continuations, state, faults, notify, pauses }
}

async function setup(assertCheckoutAvailable?: (cwd: string) => void) {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-collaboration-'))
  const children = new Map<string, ReturnType<typeof fakeSession>>()
  const events: DesktopEvent[] = []
  const creationFaults: { snapshotGate?: Promise<void> } = {}
  const bridge = createHostCollaborationBridge({
    assertCheckoutAvailable,
    dataRoot: directory,
    createSession: (cwd, notify, key) => {
      const fake = fakeSession(cwd, notify, (session, report) =>
        bridge.dispatch(
          session,
          { id: randomUUID(), method: 'finish_agent', params: { report } },
          new AbortController().signal,
        ),
      )
      Object.assign(fake.faults, creationFaults)
      children.set(key, fake)
      return fake.session
    },
    emit: (event) => events.push(event),
  })
  const root = fakeSession(directory, {
    connection: () => {},
    event: (event) => {
      bridge.decorateRootEvent('root-key', event)
    },
    error: () => {},
  })
  await bridge.bindRoot({
    sessionKey: 'root-key',
    cwd: directory,
    state: root.state,
    accessMode: 'workspace-write',
    session: root.session,
  })
  const begin = async (mode: TaskMode = 'default') => {
    root.state.mode = mode
    await bridge.beginRootRun('root-key', { mode, message: '根任务' })
  }
  const call = async (
    session: RuntimeSdkSession,
    method: CollaborationRequest['method'],
    params: unknown,
    signal = new AbortController().signal,
    id = randomUUID(),
  ) => {
    const result = await bridge.dispatch(session, { id, method, params } as CollaborationRequest, signal)
    if (method === 'wait_agent') {
      const event: DesktopEvent = {
        generation: 1,
        event: {
          type: 'message_end',
          message: {
            role: 'toolResult',
            toolCallId: id,
            toolName: 'wait_agent',
            content: [],
            details: result,
            isError: false,
            timestamp: Date.now(),
          },
        },
      }
      if (session === root.session) bridge.decorateRootEvent('root-key', event)
      else [...children.values()].find((child) => child.session === session)!.notify.event(event)
    }
    return result
  }
  const spawn = async (name: string, session = root.session) =>
    (await call(session, 'spawn_agent', { task_name: name, message: '子任务', fork_turns: 'none' })) as AgentSummary
  const until = async (predicate: () => Promise<boolean>) => {
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      if (await predicate()) return
      await new Promise<void>((resolve) => setTimeout(resolve, 1))
    }
    throw new Error('状态未达到预期')
  }
  return {
    directory,
    bridge,
    children,
    events,
    creationFaults,
    root,
    begin,
    call,
    spawn,
    until,
    cleanup: async () => {
      await bridge.stopAndWait()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

export { fakeSession, setup }
