import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { PiSessionsSnapshot } from '@pi-meme/contracts/sessions'
import { useSessions } from '../src/ui/use-sessions'

afterEach(cleanup)

function makeSnapshot(name: string): PiSessionsSnapshot {
  return {
    projects: [],
    recents: [
      {
        id: name,
        path: `/${name}.jsonl`,
        cwd: '/work',
        name,
        messageCount: 1,
        created: '2026-10-26T00:00:00Z',
        modified: '2026-10-26T00:00:00Z',
      },
    ],
    pinnedPaths: [],
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

test('并发刷新合并：进行中多次触发仅追加一次后续读取', async () => {
  const first = deferred<PiSessionsSnapshot>()
  const second = deferred<PiSessionsSnapshot>()

  let callCount = 0
  const getSessions = vi.fn().mockImplementation(() => {
    callCount++
    if (callCount === 1) return first.promise
    if (callCount === 2) return second.promise
    return Promise.resolve(makeSnapshot('extra'))
  })

  let onSessionsChangedCallback: (() => void) | undefined
  const bridge = {
    getSessions,
    onSessionsChanged: (cb: () => void) => {
      onSessionsChangedCallback = cb
      return () => {}
    },
  }

  const { result } = renderHook(() => useSessions(bridge, true))
  expect(getSessions).toHaveBeenCalledTimes(1)
  expect(result.current.sessionsLoading).toBe(true)

  let p1!: Promise<void>
  let p2!: Promise<void>
  act(() => {
    p1 = result.current.refreshSessions()
    p2 = result.current.refreshSessions()
    onSessionsChangedCallback?.()
  })

  expect(getSessions).toHaveBeenCalledTimes(1)

  await act(async () => {
    first.resolve(makeSnapshot('first'))
  })

  expect(getSessions).toHaveBeenCalledTimes(2)

  await act(async () => {
    second.resolve(makeSnapshot('second'))
    await p1
    await p2
  })

  expect(result.current.sessionsLoading).toBe(false)
  expect(result.current.sessions?.recents[0]?.name).toBe('second')
  expect(getSessions).toHaveBeenCalledTimes(2)
})

test('慢请求跨多次 tick 后无事件不 trailing，轮询跳过且不续刷', async () => {
  vi.useFakeTimers()
  try {
    const pending = deferred<PiSessionsSnapshot>()
    const getSessions = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(makeSnapshot('polled'))
    const bridge = {
      getSessions,
      onSessionsChanged: () => () => {},
    }

    const { result } = renderHook(() => useSessions(bridge, true))
    expect(getSessions).toHaveBeenCalledTimes(1)

    // 慢请求跨越多次 2s 轮询周期
    await act(async () => {
      vi.advanceTimersByTime(2000)
    })
    await act(async () => {
      vi.advanceTimersByTime(2000)
    })
    await act(async () => {
      vi.advanceTimersByTime(2000)
    })

    expect(getSessions).toHaveBeenCalledTimes(1)

    await act(async () => {
      pending.resolve(makeSnapshot('done'))
    })

    // 无事件时不追加 trailing
    expect(getSessions).toHaveBeenCalledTimes(1)
    expect(result.current.sessions?.recents[0]?.name).toBe('done')
    expect(result.current.sessionsLoading).toBe(false)

    // 下次定时 tick 正常发起轮询
    await act(async () => {
      vi.advanceTimersByTime(2000)
    })
    expect(getSessions).toHaveBeenCalledTimes(2)
  } finally {
    vi.useRealTimers()
  }
})

test('显式 await refreshSessions 在慢请求跨多次 tick 时正常完成，不被轮询无限续刷', async () => {
  vi.useFakeTimers()
  try {
    const pending = deferred<PiSessionsSnapshot>()
    const getSessions = vi.fn().mockReturnValue(pending.promise)
    const bridge = {
      getSessions,
      onSessionsChanged: () => () => {},
    }

    let refreshDone = false
    const { result } = renderHook(() => useSessions(bridge, true))
    expect(getSessions).toHaveBeenCalledTimes(1)

    let refreshPromise!: Promise<void>
    act(() => {
      refreshPromise = result.current.refreshSessions().then(() => {
        refreshDone = true
      })
    })

    // 慢请求期间跨越多次定时轮询
    await act(async () => {
      vi.advanceTimersByTime(2000)
    })
    await act(async () => {
      vi.advanceTimersByTime(2000)
    })

    expect(refreshDone).toBe(false)

    await act(async () => {
      pending.resolve(makeSnapshot('done'))
      await refreshPromise
    })

    // 显式等待正常完成，未被定时轮询阻滞
    expect(refreshDone).toBe(true)
    expect(result.current.sessions?.recents[0]?.name).toBe('done')
  } finally {
    vi.useRealTimers()
  }
})

test('正在读取期间实际 unmount，过期结果不提交且不更新状态', async () => {
  const pending = deferred<PiSessionsSnapshot>()
  const getSessions = vi.fn().mockReturnValue(pending.promise)
  const bridge = {
    getSessions,
    onSessionsChanged: () => () => {},
  }

  const { result, unmount } = renderHook(() => useSessions(bridge, true))
  expect(getSessions).toHaveBeenCalledTimes(1)

  unmount()

  await act(async () => {
    pending.resolve(makeSnapshot('unmounted'))
  })

  expect(result.current.sessions).toBeNull()
  expect(getSessions).toHaveBeenCalledTimes(1)
})

test('正在读取期间 enabled 变为 false，过期结果不提交且不触发后续刷新', async () => {
  const pending = deferred<PiSessionsSnapshot>()
  const getSessions = vi.fn().mockReturnValue(pending.promise)
  const bridge = {
    getSessions,
    onSessionsChanged: () => () => {},
  }

  const { result, rerender } = renderHook(({ enabled }) => useSessions(bridge, enabled), {
    initialProps: { enabled: true },
  })

  expect(getSessions).toHaveBeenCalledTimes(1)

  rerender({ enabled: false })
  expect(result.current.sessions).toBeNull()
  expect(result.current.sessionsLoading).toBe(false)

  await act(async () => {
    pending.resolve(makeSnapshot('late'))
  })

  expect(result.current.sessions).toBeNull()
  expect(getSessions).toHaveBeenCalledTimes(1)
})

test('同步读取异常也释放进行中的刷新，下一次调用可以重试', async () => {
  const getSessions = vi
    .fn()
    .mockImplementationOnce(() => {
      throw new Error('连接不可用')
    })
    .mockResolvedValue(makeSnapshot('retried'))
  const bridge = { getSessions, onSessionsChanged: () => () => {} }
  const { result } = renderHook(() => useSessions(bridge))
  await act(async () => {})
  expect(result.current.sessionsLoading).toBe(false)
  await act(async () => {
    await result.current.refreshSessions()
  })
  expect(getSessions).toHaveBeenCalledTimes(2)
  expect(result.current.sessions?.recents[0]?.name).toBe('retried')
})

test('读取失败后状态复位，再次刷新可正常恢复', async () => {
  const first = deferred<PiSessionsSnapshot>()
  const second = deferred<PiSessionsSnapshot>()

  let callCount = 0
  const getSessions = vi.fn().mockImplementation(() => {
    callCount++
    if (callCount === 1) return first.promise
    return second.promise
  })

  const bridge = {
    getSessions,
    onSessionsChanged: () => () => {},
  }

  const { result } = renderHook(() => useSessions(bridge, true))
  expect(getSessions).toHaveBeenCalledTimes(1)

  await act(async () => {
    first.reject(new Error('网络故障'))
  })

  expect(result.current.sessionsLoading).toBe(false)
  expect(result.current.sessions).toBeNull()

  let retryPromise!: Promise<void>
  act(() => {
    retryPromise = result.current.refreshSessions()
  })

  expect(getSessions).toHaveBeenCalledTimes(2)
  expect(result.current.sessionsLoading).toBe(true)

  await act(async () => {
    second.resolve(makeSnapshot('recovered'))
    await retryPromise
  })

  expect(result.current.sessionsLoading).toBe(false)
  expect(result.current.sessions?.recents[0]?.name).toBe('recovered')
})

test('bridge 改变时隔离旧批次及其 trailing，不影响新 bridge 批次', async () => {
  const oldPending = deferred<PiSessionsSnapshot>()
  const newPending = deferred<PiSessionsSnapshot>()

  const oldGetSessions = vi.fn().mockReturnValue(oldPending.promise)
  const newGetSessions = vi.fn().mockReturnValue(newPending.promise)

  let oldOnChanged: (() => void) | undefined
  const bridgeA = {
    getSessions: oldGetSessions,
    onSessionsChanged: (cb: () => void) => {
      oldOnChanged = cb
      return () => {}
    },
  }
  const bridgeB = {
    getSessions: newGetSessions,
    onSessionsChanged: () => () => {},
  }

  const { result, rerender } = renderHook(({ bridge }) => useSessions(bridge, true), {
    initialProps: { bridge: bridgeA },
  })

  expect(oldGetSessions).toHaveBeenCalledTimes(1)

  // 旧 bridge 在读取期间触发事件要求 trailing
  act(() => {
    oldOnChanged?.()
  })

  rerender({ bridge: bridgeB })
  expect(newGetSessions).toHaveBeenCalledTimes(1)

  await act(async () => {
    oldPending.resolve(makeSnapshot('old'))
  })

  // 旧请求及旧 trailing 均不影响新批次
  expect(oldGetSessions).toHaveBeenCalledTimes(1)
  expect(result.current.sessions).toBeNull()

  await act(async () => {
    newPending.resolve(makeSnapshot('new'))
  })

  expect(result.current.sessions?.recents[0]?.name).toBe('new')
  expect(newGetSessions).toHaveBeenCalledTimes(1)
})

test('enabled 切换时旧批次 trailing 失效，重新启用时从新代次发起读取', async () => {
  const oldPending = deferred<PiSessionsSnapshot>()
  const newPending = deferred<PiSessionsSnapshot>()

  let count = 0
  const getSessions = vi.fn().mockImplementation(() => {
    count++
    if (count === 1) return oldPending.promise
    return newPending.promise
  })

  let onChanged: (() => void) | undefined
  const bridge = {
    getSessions,
    onSessionsChanged: (cb: () => void) => {
      onChanged = cb
      return () => {}
    },
  }

  const { result, rerender } = renderHook(({ enabled }) => useSessions(bridge, enabled), {
    initialProps: { enabled: true },
  })

  expect(getSessions).toHaveBeenCalledTimes(1)

  act(() => {
    onChanged?.()
  })

  rerender({ enabled: false })
  expect(result.current.sessions).toBeNull()

  await act(async () => {
    oldPending.resolve(makeSnapshot('old'))
  })
  expect(getSessions).toHaveBeenCalledTimes(1)

  rerender({ enabled: true })
  expect(getSessions).toHaveBeenCalledTimes(2)

  await act(async () => {
    newPending.resolve(makeSnapshot('re-enabled'))
  })
  expect(result.current.sessions?.recents[0]?.name).toBe('re-enabled')
})
