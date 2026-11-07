import type { AccessSandboxOperations, AccessSandboxOptions } from './access-sandbox'

/** Model inference and controlled file adapters do not depend on an arbitrary-process backend. */
export function lazyAccessSandbox(
  options: AccessSandboxOptions,
  create: (options: AccessSandboxOptions) => Promise<AccessSandboxOperations>,
  active: () => boolean = () => true,
): AccessSandboxOperations {
  let controller = new AbortController()
  let pending: Promise<AccessSandboxOperations> | undefined
  let current: AccessSandboxOperations | undefined
  let stopping: Promise<void> | undefined
  const assertGeneration = (generation: AbortController) => {
    generation.signal.throwIfAborted()
    if (generation !== controller || stopping || !active()) throw new Error('执行已暂停、取消或正在停止')
  }
  const get = async () => {
    const generation = controller
    assertGeneration(generation)
    const sandbox = await (pending ??= create({
      ...options,
      signal: options.signal ? AbortSignal.any([options.signal, generation.signal]) : generation.signal,
    }).then(async (sandbox) => {
      if (generation.signal.aborted || !active()) {
        await sandbox.stopAll()
        throw new Error('执行沙箱已释放')
      }
      current = sandbox
      return sandbox
    }))
    assertGeneration(generation)
    return { sandbox, generation }
  }
  const signalFor = (generation: AbortController, signal?: AbortSignal) => {
    assertGeneration(generation)
    signal?.throwIfAborted()
    return signal ? AbortSignal.any([generation.signal, signal]) : generation.signal
  }
  return {
    get workspace() {
      return current?.workspace ?? options.cwd
    },
    get report() {
      return current?.report
    },
    run: async (executable, args, options) => {
      const { sandbox, generation } = await get()
      return sandbox.run(executable, args, { ...options, signal: signalFor(generation, options.signal) })
    },
    startManaged: async (executable, args, options) => {
      const { sandbox, generation } = await get()
      return sandbox.startManaged(executable, args, { ...options, signal: signalFor(generation, options.signal) })
    },
    startStdio: async (executable, args, options) => {
      const { sandbox, generation } = await get()
      if (!sandbox.startStdio) throw new Error('sandbox-unavailable: 执行器不支持受限 stdio')
      return sandbox.startStdio(executable, args, { ...options, signal: signalFor(generation, options.signal) })
    },
    assertWritable: async (target) => {
      const { sandbox, generation } = await get()
      await sandbox.assertWritable(target)
      assertGeneration(generation)
    },
    mkdir: async (target, signal) => {
      const { sandbox, generation } = await get()
      return sandbox.mkdir(target, signalFor(generation, signal))
    },
    writeFile: async (target, content, signal, expected) => {
      const { sandbox, generation } = await get()
      return sandbox.writeFile(target, content, signalFor(generation, signal), expected)
    },
    stopAll: async () => {
      const previousStop = stopping
      const generation = controller
      const starting = pending
      const existing = current
      generation.abort()
      pending = undefined
      current = undefined
      const job = (async () => {
        await previousStop
        const sandbox = existing ?? (await starting?.catch(() => undefined))
        await sandbox?.stopAll()
        if (controller === generation) controller = new AbortController()
      })()
      stopping = job
      try {
        await job
      } finally {
        if (stopping === job) stopping = undefined
      }
    },
  }
}

/** A caller keeps this run ticket even when the shared lazy backend later becomes reusable. */
export function scopedAccessSandbox(
  sandbox: AccessSandboxOperations,
  run: AbortSignal,
): AccessSandboxOperations & { readonly stopped: boolean } {
  run.throwIfAborted()
  let stopped = false
  let stopping: Promise<void> | undefined
  const signalFor = (signal?: AbortSignal) => {
    run.throwIfAborted()
    if (stopped) throw new Error('scope-expired: 原执行沙箱已停止')
    signal?.throwIfAborted()
    return signal ? AbortSignal.any([run, signal]) : run
  }
  const stop = () => {
    if (stopping) return stopping
    stopped = true
    run.removeEventListener('abort', abort)
    try {
      stopping = sandbox.stopAll()
    } catch (cause) {
      stopping = Promise.reject(cause)
    }
    void stopping.catch(() => {})
    return stopping
  }
  function abort() {
    void stop().catch(() => {})
  }
  run.addEventListener('abort', abort, { once: true })
  return {
    get stopped() {
      return stopped
    },
    get workspace() {
      return sandbox.workspace
    },
    get report() {
      return sandbox.report
    },
    run: (executable, args, options) =>
      sandbox.run(executable, args, { ...options, signal: signalFor(options.signal) }),
    startManaged: (executable, args, options) =>
      sandbox.startManaged(executable, args, { ...options, signal: signalFor(options.signal) }),
    startStdio: (executable, args, options) => {
      if (!sandbox.startStdio) throw new Error('sandbox-unavailable: 执行器不支持受限 stdio')
      return sandbox.startStdio(executable, args, { ...options, signal: signalFor(options.signal) })
    },
    assertWritable: async (target) => {
      signalFor()
      await sandbox.assertWritable(target)
      signalFor()
    },
    mkdir: (target, signal) => sandbox.mkdir(target, signalFor(signal)),
    writeFile: (target, content, signal, expected) => sandbox.writeFile(target, content, signalFor(signal), expected),
    stopAll: stop,
  }
}
