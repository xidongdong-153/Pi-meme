import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppProject, HostApi, MutationOptions } from '@pi-meme/contracts/app-host'
import type {
  MemoryConfig,
  MemoryEntry,
  MemoryEntryInput,
  MemoryPage,
  MemoryScope,
  MemoryStatus,
} from '@pi-meme/contracts/memory'

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))
export function memoryScopeKey(scope: MemoryScope) {
  return scope.kind === 'global' ? 'global' : `project:${scope.projectId}`
}
export function parseMemoryScope(key: string): MemoryScope | undefined {
  if (key === 'global') return { kind: 'global' }
  if (key.startsWith('project:') && key.length > 8) return { kind: 'project', projectId: key.slice(8) }
  return undefined
}
type ConfigPatch = Partial<Omit<MemoryConfig, 'revision'>>

/** Only confirmed Host responses replace data. Read refreshes never discard an editor draft. */
export function useMemorySettings(host: HostApi, connected: boolean) {
  const [support, setSupport] = useState<'checking' | 'supported' | 'unsupported'>('checking')
  const [status, setStatus] = useState<MemoryStatus>()
  const [projects, setProjects] = useState<AppProject[]>([])
  const [page, setPage] = useState<MemoryPage>()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined])
  const [pageIndex, setPageIndex] = useState(0)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState('')
  const [writeError, setWriteError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState('')
  const [failedConfig, setFailedConfig] = useState<ConfigPatch>()
  const lifetime = useRef(0)
  const readSequence = useRef(0)
  const mutationBusy = useRef(false)
  const mutationSequence = useRef(0)
  const attempts = useRef(new Map<string, MutationOptions>())
  const boundHost = useRef(host)
  const sameHost = boundHost.current === host
  const current = useRef({ host, connected, status, query, filter, cursors, pageIndex, support })
  current.current = { host, connected, status, query, filter, cursors, pageIndex, support }

  const read = useCallback(async (firstPage = false) => {
    const value = current.current
    if (!value.connected || value.support !== 'supported' || !value.host.memory) return
    const owner = lifetime.current
    const sequence = ++readSequence.current
    setReading(true)
    try {
      const [snapshot, entries] = await Promise.all([
        value.host.memory.status(),
        value.host.memory.list({
          query: value.query.trim() || undefined,
          scope: parseMemoryScope(value.filter),
          cursor: firstPage ? undefined : value.cursors[value.pageIndex],
          limit: 50,
        }),
      ])
      if (owner !== lifetime.current || sequence !== readSequence.current) return
      setStatus((previous) => (!previous || snapshot.revision >= previous.revision ? snapshot : previous))
      setPage(entries)
      if (firstPage) {
        setCursors([undefined])
        setPageIndex(0)
      }
      setError('')
    } catch (cause) {
      if (owner === lifetime.current && sequence === readSequence.current) setError(messageOf(cause))
    } finally {
      if (owner === lifetime.current && sequence === readSequence.current) setReading(false)
    }
  }, [])

  const connect = useCallback(async () => {
    if (!current.current.connected) return
    const owner = lifetime.current
    setReading(true)
    try {
      const capabilities = await host.capabilities()
      if (owner !== lifetime.current) return
      if (!(capabilities.features as readonly string[]).includes('memory') || !host.memory) {
        setSupport('unsupported')
        return
      }
      setSupport('supported')
      current.current = { ...current.current, support: 'supported' }
      const [, projectRead] = await Promise.allSettled([read(), host.projects.list()])
      if (owner !== lifetime.current) return
      if (projectRead.status === 'fulfilled') setProjects(projectRead.value)
      else setError(`无法读取项目范围：${messageOf(projectRead.reason)}`)
    } catch (cause) {
      if (owner === lifetime.current) setError(`无法读取服务能力：${messageOf(cause)}`)
    } finally {
      if (owner === lifetime.current) setReading(false)
    }
  }, [host, read])

  useEffect(() => {
    lifetime.current++
    mutationSequence.current++
    mutationBusy.current = false
    setBusy('')
    setReading(false)
    if (boundHost.current !== host) {
      boundHost.current = host
      attempts.current.clear()
      setStatus(undefined)
      setPage(undefined)
      setProjects([])
      setSupport('checking')
      setError('')
      setWriteError('')
      setNotice('')
      setFailedConfig(undefined)
      current.current = { ...current.current, status: undefined, support: 'checking' }
    }
    if (connected) void connect()
    return () => {
      lifetime.current++
      readSequence.current++
    }
  }, [host, connected, connect])

  useEffect(() => {
    if (support !== 'supported' || !connected) return
    const timer = window.setTimeout(() => void read(), 200)
    return () => window.clearTimeout(timer)
  }, [query, filter, pageIndex, support, connected, read])

  useEffect(() => {
    if (support !== 'supported' || !connected) return
    const refresh = () => {
      if (document.visibilityState !== 'hidden' && !mutationBusy.current) void read()
    }
    const timer = window.setInterval(refresh, 10000)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    let disposed = false
    let unsubscribe: (() => void) | undefined
    void host.events
      .subscribe({}, (event) => {
        if (event.type === 'resync' || String(event.type) === 'memory') refresh()
      })
      .then(
        (off) => {
          if (disposed) off()
          else unsubscribe = off
        },
        () => {},
      )
    return () => {
      disposed = true
      unsubscribe?.()
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [host, support, connected, read])

  const run = useCallback(
    async <T>(
      key: string,
      intent: unknown,
      work: (options: MutationOptions) => Promise<T>,
      accepted: (value: T) => void,
      success: string,
    ) => {
      const value = current.current
      if (mutationBusy.current) return false
      if (
        !value.connected ||
        boundHost.current !== value.host ||
        value.support !== 'supported' ||
        !value.host.memory ||
        !value.status
      ) {
        setWriteError('服务未连接或尚未就绪，无法保存。')
        return false
      }
      mutationBusy.current = true
      const sequence = ++mutationSequence.current
      const intentKey = JSON.stringify([key, intent])
      let options = attempts.current.get(intentKey)
      if (!options) {
        options = { idempotencyKey: crypto.randomUUID() }
        attempts.current.set(intentKey, options)
      }
      const owner = lifetime.current
      setBusy(key)
      setWriteError('')
      setNotice('')
      try {
        const result = await work(options)
        if (owner !== lifetime.current) return false
        attempts.current.delete(intentKey)
        accepted(result)
        setNotice(success)
        await read(key === 'clear')
        return true
      } catch (cause) {
        if (owner === lifetime.current) setWriteError(messageOf(cause))
        return false
      } finally {
        if (sequence === mutationSequence.current) {
          mutationBusy.current = false
          if (owner === lifetime.current) setBusy('')
        }
      }
    },
    [read],
  )

  const configure = async (patch: ConfigPatch) => {
    const value = current.current
    if (!value.status || !value.host.memory) return false
    const owner = lifetime.current
    const saved = await run(
      `config:${Object.keys(patch).join(',')}`,
      [patch, value.status.config.revision],
      (options) => value.host.memory!.configure(patch, value.status!.config.revision, options),
      (next) => {
        setStatus((previous) => (!previous || next.revision >= previous.revision ? next : previous))
        setFailedConfig(undefined)
      },
      '设置已保存',
    )
    if (!saved && owner === lifetime.current) setFailedConfig(patch)
    return saved
  }
  const save = async (input: MemoryEntryInput, original: MemoryEntry | undefined, epoch: number) => {
    const api = current.current.host.memory
    if (!api) return undefined
    let saved: MemoryEntry | undefined
    await run(
      'entry',
      [input, original?.id, original?.revision, epoch],
      (options) =>
        original ? api.update(original.id, input, original.revision, options) : api.create(input, epoch, options),
      (next) => {
        saved = next
      },
      '记忆已保存',
    )
    return saved
  }
  const remove = async (entry: MemoryEntry) => {
    const api = current.current.host.memory
    if (!api) return false
    return run(
      'remove',
      [entry.id, entry.revision],
      (options) => api.remove(entry.id, entry.revision, options),
      () => {
        setPage((previous) =>
          previous ? { ...previous, entries: previous.entries.filter((item) => item.id !== entry.id) } : previous,
        )
      },
      '记忆已删除',
    )
  }
  const clear = async (revision: number) => {
    const api = current.current.host.memory
    if (!api) return false
    return run(
      'clear',
      revision,
      (options) => api.clear(revision, options),
      (next) => {
        setStatus((previous) => (!previous || next.revision >= previous.revision ? next : previous))
        setPage({ entries: [], revision: next.revision })
      },
      '全部记忆已清空',
    )
  }
  const controlJob = async (action: 'stop' | 'retry', id: string) => {
    const api = current.current.host.memory
    if (!api) return false
    return run(
      `${action}:${id}`,
      id,
      (options) => api[action](id, options),
      () => {},
      action === 'stop' ? '任务已停止' : '已请求重试',
    )
  }

  return {
    support: sameHost ? support : 'checking',
    status: sameHost ? status : undefined,
    projects: sameHost ? projects : [],
    page: sameHost ? page : undefined,
    query,
    filter,
    pageIndex,
    reading,
    error,
    writeError,
    notice,
    busy,
    failedConfig,
    writable: sameHost && connected && support === 'supported' && Boolean(status) && !status?.error && !busy,
    reload: () => (support === 'supported' ? read() : connect()),
    configure,
    save,
    remove,
    clear,
    controlJob,
    search: (value: string) => {
      readSequence.current++
      setQuery(value)
      setCursors([undefined])
      setPageIndex(0)
    },
    selectFilter: (value: string) => {
      readSequence.current++
      setFilter(value)
      setCursors([undefined])
      setPageIndex(0)
    },
    nextPage: () => {
      if (!page?.nextCursor || reading) return
      readSequence.current++
      setCursors((values) => [...values.slice(0, pageIndex + 1), page.nextCursor])
      setPageIndex((value) => value + 1)
    },
    previousPage: () => {
      readSequence.current++
      setPageIndex((value) => Math.max(0, value - 1))
    },
  }
}
