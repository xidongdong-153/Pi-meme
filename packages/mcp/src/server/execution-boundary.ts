import { AsyncLocalStorage } from 'node:async_hooks'
import type { McpTransport } from '@earendil-works/pi-mcp'

export type McpExecutionGeneration = { readonly id: number; readonly signal: AbortSignal }
type Generation = {
  ticket: McpExecutionGeneration
  controller: AbortController
  resources: Set<{ close: () => Promise<void> }>
  work: Set<Promise<unknown>>
}

/** Cancellation fences a generation synchronously; resumption never revives its async context. */
export class McpExecutionBoundary {
  private readonly scope = new AsyncLocalStorage<McpExecutionGeneration>()
  private readonly logicalTool = new AsyncLocalStorage<{ claimed: boolean }>()
  private sequence = 0
  private revision = 0
  private paused = false
  private blocked = false
  private disposed = false
  private current = this.generation()
  private draining: Promise<void> = Promise.resolve()

  private generation(): Generation {
    const controller = new AbortController()
    return {
      ticket: { id: ++this.sequence, signal: controller.signal },
      controller,
      resources: new Set(),
      work: new Set(),
    }
  }
  capture(): McpExecutionGeneration {
    const ticket = this.scope.getStore() ?? this.current.ticket
    this.assert(ticket)
    return ticket
  }
  assert(ticket: McpExecutionGeneration): void {
    const ambient = this.scope.getStore()
    if (
      this.disposed ||
      this.blocked ||
      ticket !== this.current.ticket ||
      ticket.signal.aborted ||
      (ambient && ambient !== ticket)
    )
      throw new Error('scope-expired: MCP 执行代次已取消或暂停')
  }
  async invoke<T>(action: () => T | Promise<T>): Promise<T> {
    const ticket = this.capture()
    const result = await this.scope.run(ticket, action)
    this.assert(ticket)
    return result
  }
  invokeTool<T>(action: () => T | Promise<T>): Promise<T> {
    return this.invoke(() => this.logicalTool.run({ claimed: false }, action))
  }
  claimToolCall(): void {
    this.capture()
    const call = this.logicalTool.getStore()
    if (!call || call.claimed) throw new Error('mcp-replay-denied: 工具调用必须来自新的明确执行，不能隐式重放')
    call.claimed = true
  }
  perform<T>(ticket: McpExecutionGeneration, action: () => T | Promise<T>): Promise<T> {
    this.assert(ticket)
    const state = this.current
    const work = Promise.resolve()
      .then(() => {
        this.assert(ticket)
        return this.scope.run(ticket, action)
      })
      .then((result) => {
        this.assert(ticket)
        return result
      })
    state.work.add(work)
    void work.finally(() => state.work.delete(work)).catch(() => {})
    return work
  }
  bind(transport: McpTransport, ticket: McpExecutionGeneration): McpTransport {
    this.assert(ticket)
    const state = this.current
    let closing: Promise<void> | undefined
    const resource = { close }
    function close() {
      return (closing ??= transport.close().finally(() => state.resources.delete(resource)))
    }
    state.resources.add(resource)
    return {
      start: () => this.perform(ticket, () => transport.start()),
      send: (message, options) =>
        this.perform(ticket, () =>
          transport.send(message, {
            ...options,
            signal: options?.signal ? AbortSignal.any([ticket.signal, options.signal]) : ticket.signal,
          }),
        ),
      close,
      onMessage: (listener) =>
        transport.onMessage((message) => {
          if (!ticket.signal.aborted) listener(message)
        }),
      onError: (listener) => transport.onError(listener),
      // The SDK must see close even after cancellation, so its reusable connection becomes disconnected.
      onClose: (listener) => transport.onClose(listener),
      setProtocolVersion: (version) => {
        this.assert(ticket)
        transport.setProtocolVersion?.(version)
      },
    }
  }
  /** Abort the actual fetch and drain its body, including detached SSE consumers. */
  fetch(
    ticket: McpExecutionGeneration,
    input: string | URL,
    init?: RequestInit,
    settled?: (failed: boolean) => Promise<void>,
  ): Promise<Response> {
    const state = this.current
    return this.perform(ticket, async () => {
      let response: Response | undefined
      try {
        response = await fetch(input, {
          ...init,
          signal: init?.signal ? AbortSignal.any([ticket.signal, init.signal]) : ticket.signal,
        })
        this.assert(ticket)
      } catch (cause) {
        await response?.body?.cancel().catch(() => {})
        await settled?.(true)
        throw cause
      }
      if (!response.body) {
        await settled?.(false)
        return response
      }
      const reader = response.body.getReader()
      let resolve!: () => void
      let reject!: (cause: unknown) => void
      const done = new Promise<void>((yes, no) => {
        resolve = yes
        reject = no
      })
      state.work.add(done)
      void done.finally(() => state.work.delete(done)).catch(() => {})
      let completed = false
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined
      const finish = async (failed: boolean) => {
        if (completed) return done
        completed = true
        ticket.signal.removeEventListener('abort', abort)
        try {
          await settled?.(failed)
          resolve()
        } catch (cause) {
          reject(cause)
          throw cause
        }
      }
      function abort() {
        controller?.error(new Error('scope-expired: MCP HTTP 流已取消'))
        void reader
          .cancel()
          .catch(() => {})
          .then(() => finish(true))
          .catch(() => {})
      }
      const stream = new ReadableStream<Uint8Array>({
        start: (value) => {
          controller = value
        },
        pull: async (value) => {
          try {
            this.assert(ticket)
            const next = await reader.read()
            this.assert(ticket)
            if (next.done) {
              await finish(false)
              value.close()
            } else value.enqueue(next.value)
          } catch (cause) {
            await reader.cancel().catch(() => {})
            await finish(true).catch(() => {})
            value.error(cause)
          }
        },
        cancel: async () => {
          await reader.cancel().catch(() => {})
          await finish(ticket.signal.aborted || init?.signal?.aborted === true)
        },
      })
      ticket.signal.addEventListener('abort', abort, { once: true })
      if (ticket.signal.aborted) abort()
      const wrapped = new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
      Object.defineProperties(wrapped, {
        url: { value: response.url },
        redirected: { value: response.redirected },
        type: { value: response.type },
      })
      return wrapped
    })
  }
  cancel(reason: string, paused: boolean): Promise<void> {
    ++this.revision
    this.paused = this.paused || paused
    this.blocked = true
    const state = this.current
    state.controller.abort(new Error(`MCP execution boundary: ${reason}`))
    const drain = async () => {
      const results = await Promise.allSettled([...state.resources].map((resource) => resource.close()))
      while (state.work.size) await Promise.allSettled([...state.work])
      const failure = results.find((result) => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    }
    this.draining = Promise.allSettled([this.draining, drain()]).then((results) => {
      const failure = results.find((result) => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    })
    return this.draining
  }
  async resume(): Promise<void> {
    if (this.disposed) throw new Error('scope-expired: MCP runtime 已释放')
    const revision = this.revision
    await this.draining
    if (revision !== this.revision) return
    this.paused = false
    if (this.blocked) {
      this.current = this.generation()
      this.blocked = false
    }
  }
  async agentStart(): Promise<void> {
    if (!this.paused) await this.resume()
  }
  async dispose(): Promise<void> {
    this.disposed = true
    await this.cancel('dispose', true)
  }
}
