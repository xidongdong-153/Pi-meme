import { spawn } from 'node:child_process'
import { PassThrough, Writable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { windowsNativeExecutable } from './runtime'

export type WindowsProcess = {
  pid: number
  stdin: Writable
  stdout: PassThrough
  stderr: PassThrough
  completion: Promise<{ exitCode: number | null; signal: string | null }>
  stop: () => Promise<{ exitCode: number | null; signal: string | null }>
  kill: () => void
}

export type WindowsSandboxPolicy = {
  read: string[]
  write: string[]
  deny: string[]
  allowNetwork: boolean
  allowChildren: boolean
}

/** 为已有子进程消费者保留 stdout、stdin、error 和 close 事件。 */
export class WindowsCommandProcess extends EventEmitter {
  readonly pid: number
  readonly stdin: Writable
  readonly stdout: PassThrough
  readonly stderr: PassThrough
  exitCode: number | null = null
  constructor(readonly native: WindowsProcess) {
    super()
    this.pid = native.pid
    this.stdin = native.stdin
    this.stdout = native.stdout
    this.stderr = native.stderr
    void native.completion.then(
      (result) => {
        this.exitCode = result.exitCode
        setImmediate(() => this.emit('close', result.exitCode, result.signal))
      },
      (cause) =>
        setImmediate(() => {
          this.emit('error', cause)
          this.emit('close', null, null)
        }),
    )
  }
}

/** 原生程序持有 Job；控制管道断开时由内核终止整棵进程树。 */
export async function spawnWindowsProcess(
  executable: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; sandbox?: WindowsSandboxPolicy },
): Promise<WindowsProcess> {
  const helper = spawn(await windowsNativeExecutable(), [], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const ready = Promise.withResolvers<number>()
  const exited = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>()
  void exited.promise.catch(() => {})
  let incoming = ''
  let diagnostic = ''
  let result: { exitCode: number | null; signal: string | null } | undefined
  let failure: Error | undefined
  let inputAck: ReturnType<typeof Promise.withResolvers<void>> | undefined
  const send = (message: unknown) => {
    if (!helper.stdin.destroyed) helper.stdin.write(`${JSON.stringify(message)}\n`)
  }
  const shutdown = () => helper.stdin.destroy()
  const startup = setTimeout(() => {
    failure = new Error('Windows 原生进程启动超时')
    ready.reject(failure)
    helper.kill()
  }, 30000)
  process.once('exit', shutdown)
  helper.stdin.on('error', () => {})
  helper.stderr.on('data', (chunk: Buffer) => {
    diagnostic = (diagnostic + chunk.toString()).slice(-4096)
  })
  helper.stdout.setEncoding('utf8')
  helper.stdout.on('data', (chunk: string) => {
    incoming += chunk
    try {
      if (incoming.length > 1024 * 1024) throw new Error('Windows 原生程序响应超过限制')
      for (;;) {
        const end = incoming.indexOf('\n')
        if (end === -1) break
        const event = JSON.parse(incoming.slice(0, end))
        incoming = incoming.slice(end + 1)
        if (event.type === 'spawned' && Number.isInteger(event.pid) && event.pid > 0) {
          clearTimeout(startup)
          ready.resolve(event.pid)
        } else if (event.type === 'input-ack') {
          inputAck?.resolve()
          inputAck = undefined
        } else if (event.type === 'input-error') {
          inputAck?.reject(new Error('Windows 子进程已关闭标准输入'))
          inputAck = undefined
        } else if (event.type === 'data' && ['stdout', 'stderr'].includes(event.stream) && Array.isArray(event.data)) {
          if (
            event.data.length > 8192 ||
            event.data.some((n: unknown) => !Number.isInteger(n) || Number(n) < 0 || Number(n) > 255)
          )
            throw new Error('Windows 原生程序输出格式无效')
          ;(event.stream === 'stdout' ? stdout : stderr).write(Buffer.from(event.data))
        } else if (event.type === 'exit' && Number.isInteger(event.exitCode)) {
          result = { exitCode: event.exitCode, signal: null }
          helper.stdin.end()
        } else if (event.type === 'error' && typeof event.message === 'string') throw new Error(event.message)
        else throw new Error('Windows 原生程序响应格式无效')
      }
    } catch (cause) {
      failure = cause instanceof Error ? cause : new Error(String(cause))
      ready.reject(failure)
      shutdown()
    }
  })
  helper.once('error', (cause) => {
    failure = cause
    ready.reject(cause)
  })
  helper.once('close', (helperCode) => {
    clearTimeout(startup)
    process.removeListener('exit', shutdown)
    stdout.end()
    stderr.end()
    helper.stdin.destroy()
    inputAck?.reject(failure ?? new Error('Windows 子进程已退出，无法继续写入'))
    inputAck = undefined
    if (result && !failure) exited.resolve(result)
    else {
      const cause =
        failure ?? new Error(`Windows 原生程序未确认进程树退出：${diagnostic || `控制管道已关闭（${helperCode}）`}`)
      ready.reject(cause)
      exited.reject(cause)
    }
  })
  helper.stdin.write(
    `${JSON.stringify({ executable, args, cwd: options.cwd, env: Object.fromEntries(Object.entries(options.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), ...(options.sandbox ? { sandbox: options.sandbox } : {}) })}\n`,
  )
  const pid = await ready.promise
  const stdin = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      void (async () => {
        for (let start = 0; start < chunk.length; start += 65536) {
          if (helper.stdin.destroyed || result || failure) throw failure ?? new Error('Windows 子进程输入已关闭')
          const ack = Promise.withResolvers<void>()
          inputAck = ack
          send({ type: 'input', data: [...chunk.subarray(start, start + 65536)] })
          await ack.promise
        }
      })().then(
        () => callback(),
        (cause: Error) => callback(cause),
      )
    },
    final(callback) {
      send({ type: 'end' })
      callback()
    },
  })
  return {
    pid,
    stdin,
    stdout,
    stderr,
    completion: exited.promise,
    kill: () => send({ type: 'kill' }),
    stop: () => {
      send({ type: 'stop' })
      return exited.promise
    },
  }
}
