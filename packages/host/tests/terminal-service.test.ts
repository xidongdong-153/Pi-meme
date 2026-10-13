import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TerminalService, type PtyProcess } from '../src/terminal-service'

test('PTY输入、窗口调整、重连缓冲和插件释放使用同一个进程', async () => {
  const calls: unknown[] = []
  let data!: (value: string) => void
  let exit!: (value: { exitCode: number }) => void
  let disposed = 0
  const pty: PtyProcess = {
    write: (value) => {
      calls.push(['write', value])
    },
    resize: (cols, rows) => {
      calls.push(['resize', cols, rows])
    },
    kill: () => {
      calls.push('kill')
      exit({ exitCode: 0 })
    },
    onData: (listener) => {
      data = listener
      return {
        dispose() {
          disposed++
        },
      }
    },
    onExit: (listener) => {
      exit = listener
      return {
        dispose() {
          disposed++
        },
      }
    },
  }
  const events: unknown[] = []
  const service = new TerminalService({
    hostId: 'h',
    resolveRoot: async () => '/project',
    onEvent: (event) => events.push(event),
    pty: {
      spawn: (command, args, options) => {
        calls.push([command, args, options.cwd])
        return pty
      },
    },
  })
  const ref = await service.openOwned({ hostId: 'h', projectId: 'p' }, { command: '/bin/sh' }, 'plugin')
  await service.input(ref, 'hello\r')
  await service.resize(ref, { cols: 100, rows: 30 })
  data('输出')
  assert.equal((await service.attach(ref)).output, '输出')
  assert.equal((await service.attach(ref)).outputSequence, 1)
  data('x'.repeat(300 * 1024))
  assert.ok(Buffer.byteLength((await service.attach(ref)).output) <= 256 * 1024)
  await assert.rejects(service.resize(ref, { cols: 0, rows: 24 }))
  await assert.rejects(service.attach({ ...ref, hostId: 'other' }))
  await service.closeOwner('plugin')
  await assert.rejects(service.attach(ref))
  assert.ok(calls.includes('kill'))
  assert.ok(disposed >= 2)
  assert.equal(events.length, 3)
  await service.dispose()
})

test('没有原生PTY时报告能力不可用', async () => {
  const service = new TerminalService({ hostId: 'h', resolveRoot: async () => '/', onEvent() {}, pty: null })
  assert.equal(service.supported, false)
  await assert.rejects(service.open({ hostId: 'h', projectId: 'p' }, {}), /node-pty/)
})
