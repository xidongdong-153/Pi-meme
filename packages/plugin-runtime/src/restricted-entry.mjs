import fs from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { pathToFileURL } from 'node:url'

const scopes = new AsyncLocalStorage()
const input = fs.createReadStream(null, { fd: 4, autoClose: false })
const output = fs.createWriteStream(null, { fd: 5, autoClose: false })
const tools = new Map()
const commands = new Map()
const hooks = new Map()
const operations = new Map()
const pending = new Map()
const controllers = new Map()
const disposers = []
let bytes = Buffer.alloc(0)
let serial = 0
let identity
function send(value) {
  const body = Buffer.from(JSON.stringify(value))
  if (body.length > 4194304) throw new Error('payload-too-large: 响应过大')
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length)
  output.write(Buffer.concat([header, body]))
}
function broker(method, data, signal) {
  const scope = scopes.getStore()
  if (!scope) throw new Error('scope-expired: 没有有效执行')
  const executionSignal = controllers.get(scope)?.signal
  signal = signal && executionSignal ? AbortSignal.any([signal, executionSignal]) : (signal ?? executionSignal)
  if (signal?.aborted) return Promise.reject(new Error('cancelled: 请求已取消'))
  const id = String(++serial)
  if (pending.size >= 64) throw new Error('payload-too-large: 请求过多')
  return new Promise((resolve, reject) => {
    const abort = () => {
      pending.delete(id)
      signal?.removeEventListener('abort', abort)
      send({ type: 'brokerCancel', id, scope })
      reject(new Error('cancelled: 请求已取消'))
    }
    const cleanup = () => signal?.removeEventListener('abort', abort)
    signal?.addEventListener('abort', abort, { once: true })
    pending.set(id, { resolve, reject, cleanup })
    send({ type: 'broker', id, scope, method, input: data })
  })
}
function register(map, item) {
  const name = item.name
  if (typeof name !== 'string' || !/^[a-zA-Z][\w-]*$/.test(name) || map.has(name) || typeof item.execute !== 'function')
    throw new Error('invalid-input: 注册无效或重复')
  map.set(name, item)
}
function notify(method, input) {
  return broker(method, input).then(() => undefined)
}
function context() {
  const services = {
    server: {
      call: (operation, value, options) =>
        broker(
          'server',
          { operation: typeof operation === 'string' ? operation : operation.name, input: value },
          options?.signal,
        ),
    },
    http: { request: (value, options) => broker('http', value, options?.signal) },
    sharedData: { read: (key) => broker('sharedData', { key }) },
  }
  return {
    ...identity,
    ...services,
    tools: { register: (tool) => register(tools, tool) },
    commands: { register: (command) => register(commands, command) },
    hooks: {
      on: (name, handler) => {
        const list = hooks.get(name) ?? []
        list.push(handler)
        hooks.set(name, list)
        return () => {
          const i = list.indexOf(handler)
          if (i >= 0) list.splice(i, 1)
        }
      },
    },
    interaction: {
      request: (questions, signal) => broker('interaction', { questions }, signal),
      notify: (message, level) => notify('notify', { message, level: level ?? 'info' }),
      setStatus: (key, text) => notify('status', { key, text: text ?? null }),
    },
    messages: { emit: (message) => notify('message', message) },
    registerOperations: (list) => {
      for (const operation of list) register(operations, operation)
      return () => {
        for (const operation of list) operations.delete(operation.name)
      }
    },
    onDispose: (dispose) => disposers.push(dispose),
  }
}
async function execute(method, value, signal) {
  if (method === 'initialize') {
    identity = { pluginId: value.pluginId, generation: value.generation }
    if (value.server) {
      const mod = await import(pathToFileURL(value.server))
      if (typeof mod.create !== 'function') throw new Error('受限Server必须导出create')
      const instance = await mod.create(context())
      if (instance?.dispose) disposers.push(instance.dispose)
    }
    if (value.agent) {
      const mod = await import(pathToFileURL(value.agent))
      if (typeof mod.activate !== 'function') throw new Error('受限Agent必须导出activate')
      const dispose = await mod.activate(context())
      if (dispose) disposers.push(dispose)
    }
    if (tools.size + commands.size + operations.size > 128) throw new Error('注册数量超过限制')
    const describe = (item) => ({ ...item, execute: undefined })
    return {
      tools: [...tools.values()].map(describe),
      commands: [...commands.values()].map(describe),
      hooks: [...hooks.keys()],
      operations: [...operations.values()].map(describe),
    }
  }
  if (method === 'tool' || method === 'command') {
    const item = (method === 'tool' ? tools : commands).get(value.name)
    if (!item) throw new Error('operation-not-found')
    return item.execute(value.parameters, { ...value.execution, signal })
  }
  if (method === 'hook') {
    const result = []
    for (const hook of hooks.get(value.name) ?? []) result.push(await hook({ ...value.event, signal }))
    if (value.name === 'sessionEnd') {
      for (const dispose of disposers.reverse()) await dispose()
      disposers.length = 0
    }
    return result
  }
  if (method === 'server') {
    const item = operations.get(value.operation)
    if (!item) throw new Error('operation-not-found')
    return item.execute(value.input, { ...value.context, signal })
  }
  throw new Error('invalid-input: 未知进程操作')
}
input.on('data', (data) => {
  bytes = Buffer.concat([bytes, data])
  try {
    while (bytes.length >= 4) {
      const size = bytes.readUInt32BE(0)
      if (size > 4194304) throw new Error('payload-too-large')
      if (bytes.length < size + 4) break
      const message = JSON.parse(bytes.subarray(4, size + 4).toString())
      bytes = bytes.subarray(size + 4)
      if (message.type === 'brokerReply') {
        const call = pending.get(message.id)
        pending.delete(message.id)
        call?.cleanup()
        if (message.error) call?.reject(new Error(message.error))
        else call?.resolve(message.value)
        continue
      }
      if (message.type === 'cancel') {
        controllers.get(message.id)?.abort()
        continue
      }
      if (message.type !== 'call') throw new Error('invalid-input: 协议帧无效')
      void scopes.run(message.id, async () => {
        const controller = new AbortController()
        controllers.set(message.id, controller)
        try {
          const value = await execute(message.method, message.input, controller.signal)
          send({ type: 'reply', id: message.id, value: value ?? null })
        } catch (cause) {
          send({ type: 'reply', id: message.id, error: String(cause) })
        } finally {
          controllers.delete(message.id)
          controller.abort()
        }
      })
    }
  } catch {
    process.exit(1)
  }
})
input.on('end', () => process.exit(0))
