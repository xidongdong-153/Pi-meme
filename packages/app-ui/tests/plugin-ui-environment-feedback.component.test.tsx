import '@testing-library/jest-dom/vitest'
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { HostApi } from '@pi-meme/contracts/app-host'
import type { UiTarget } from '@pi-meme/contracts/plugin-ui-data'
import { freezeUiValue } from '@pi-meme/contracts/plugin-ui-data'
import { ChatStream } from '@pi-meme/chat/ui/model/chat-stream'
import { emptyChat } from '@pi-meme/chat/ui/model/state'
import { ErrorBoundary } from '@pi-meme/ui/components/error-boundary'
import { PluginUiDataSource } from '../src/plugins/plugin-ui-data-source'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const selectedTarget: UiTarget = { hostId: 'host', session: { hostId: 'host', sessionId: 'session' } }

// 本 Probe 只保留 App 的环境回写接线，不替代完整 App 与真实浏览器验收。
function EnvironmentProbe({
  source,
  stream,
  stable,
  counter,
}: {
  source: PluginUiDataSource
  stream: ChatStream
  stable: boolean
  counter: { effects: number }
}) {
  const metadata = useSyncExternalStore(source.reactive.metadata.subscribe, source.reactive.metadata.getSnapshot)
  const chat = useSyncExternalStore(stream.subscribe, stream.getSnapshot)
  const pluginTarget = useMemo(() => selectedTarget, [])
  const detachedTarget = useMemo(() => freezeUiValue(structuredClone(pluginTarget)), [pluginTarget])
  const pluginProps = useMemo(
    () => ({
      target: stable ? detachedTarget : freezeUiValue(structuredClone(pluginTarget)),
      snapshot: metadata.session,
    }),
    [stable, detachedTarget, pluginTarget, metadata.session],
  )
  const environmentTarget = stable ? pluginTarget : pluginProps.target
  useEffect(() => {
    counter.effects++
    // 在 React 自身深度上限之前停住错误接线，避免诊断用例烧满渲染线程。
    if (counter.effects > 12) throw new Error('bounded-feedback-loop')
    source.setEnvironment({
      target: environmentTarget,
      session: {
        status: 'ready',
        running: chat.running,
        agentPlugins: [],
        mode: 'default',
        requestedMode: 'default',
        effectiveMode: 'default',
        queue: { steering: 0, followUp: 0 },
      },
    })
  }, [source, environmentTarget, chat.running, counter])
  return <p data-testid="generation-output">{pluginProps.snapshot?.generation?.outputTokens ?? 0}</p>
}

function fixture() {
  const source = new PluginUiDataSource({} as HostApi)
  const stream = new ChatStream(emptyChat)
  source.attach(stream)
  return { source, stream }
}

function publishMetrics(stream: ChatStream, outputTokens: number, running = true) {
  stream.update({
    ...stream.getSnapshot(),
    running,
    generationMetrics: {
      running,
      phase: running ? 'generating' : 'complete',
      elapsedMs: outputTokens,
      generationMs: outputTokens,
      generationActive: running,
      outputTokens,
      estimated: true,
      receivedAt: outputTokens,
    },
  })
}

test('旧接线在首次生成指标出现后形成反馈，而非消息动作或附件触发', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const { source, stream } = fixture()
  const counter = { effects: 0 }
  try {
    render(
      <ErrorBoundary>
        <EnvironmentProbe source={source} stream={stream} stable={false} counter={counter} />
      </ErrorBoundary>,
    )
    expect(counter.effects).toBeLessThan(4)
    await act(async () => publishMetrics(stream, 1))
    await screen.findByText('bounded-feedback-loop')
    expect(counter.effects).toBeGreaterThan(12)
  } finally {
    source.dispose()
  }
})

test('独立目标身份不依赖派生metadata，生成指标与100次token更新不会回写反馈', async () => {
  const { source, stream } = fixture()
  const counter = { effects: 0 }
  try {
    render(<EnvironmentProbe source={source} stream={stream} stable counter={counter} />)
    expect(counter.effects).toBe(1)
    await act(async () => publishMetrics(stream, 1))
    await waitFor(() => expect(screen.getByTestId('generation-output')).toHaveTextContent('1'))
    expect(counter.effects).toBe(2)
    await act(async () => {
      for (let index = 2; index <= 101; index++) publishMetrics(stream, index)
    })
    expect(screen.getByTestId('generation-output')).toHaveTextContent('101')
    expect(counter.effects).toBe(2)
    await act(async () => publishMetrics(stream, 102, false))
    expect(counter.effects).toBe(3)
    expect(source.reactive.metadata.getSnapshot().session?.running).toBe(false)
  } finally {
    source.dispose()
  }
})
