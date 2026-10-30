import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import xterm from '@xterm/headless'
import { TerminalService, type PtyProcess } from '../src/terminal-service'

test('Windows 默认终端忽略 Unix SHELL，显式命令仍按原值执行', async () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  vi.stubEnv('SHELL', '/bin/zsh')
  const spawn = vi.fn<(command: string) => PtyProcess>(() => ({
    write() {},
    resize() {},
    kill() {},
    onData: () => ({ dispose() {} }),
    onExit: () => ({ dispose() {} }),
  }))
  const service = new TerminalService({
    hostId: 'windows',
    resolveRoot: async () => 'C:\\项目 目录',
    onEvent() {},
    pty: { spawn },
  })
  try {
    const root = { hostId: 'windows', projectId: 'project' }
    await service.open(root, {})
    await service.open(root, { command: 'C:\\Program Files\\Git\\bin\\bash.exe' })
    assert.equal(spawn.mock.calls[0][0], 'powershell.exe')
    assert.equal(spawn.mock.calls[1][0], 'C:\\Program Files\\Git\\bin\\bash.exe')
  } finally {
    await service.dispose()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  }
})

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
  assert.match((await service.attach(ref)).output, /^输出/)
  assert.equal((await service.attach(ref)).cols, 100)
  assert.equal((await service.attach(ref)).rows, 30)
  assert.equal((await service.attach(ref)).outputSequence, 1)
  data('x'.repeat(300 * 1024))
  assert.ok(Buffer.byteLength((await service.attach(ref)).output) <= 256 * 1024)
  await assert.rejects(service.resize(ref, { cols: 0, rows: 24 }))
  await assert.rejects(service.attach({ ...ref, hostId: 'other' }))
  const attaching = assert.rejects(service.attach(ref), /终端已关闭/)
  const resizing = assert.rejects(service.resize(ref, { cols: 120, rows: 40 }), /终端已关闭/)
  await service.closeOwner('plugin')
  await Promise.all([attaching, resizing])
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

test('大量重绘后的重连保留备用屏幕、中文、颜色、光标位置和输入模式', async () => {
  let output!: (data: string) => void
  const service = new TerminalService({
    hostId: 'h',
    resolveRoot: async () => '/project',
    onEvent() {},
    pty: {
      spawn: () => ({
        write() {},
        resize() {},
        kill() {},
        onData: (listener) => {
          output = listener
          return { dispose() {} }
        },
        onExit: () => ({ dispose() {} }),
      }),
    },
  })
  const ref = await service.open({ hostId: 'h', projectId: 'p' }, {})
  const restored = new xterm.Terminal({ cols: 80, rows: 24, allowProposedApi: true })
  try {
    output('\x1B[?1049h\x1B[?2004h\x1B[?25l\x1B[31m')
    output('\x1B[H\x1B[2J中文色块 ███'.repeat(20000))
    output('\x1B[5;9H')
    const snapshot = await service.attach(ref)
    await new Promise<void>((resolve) => restored.write(snapshot.output, resolve))
    assert.equal(restored.buffer.active.type, 'alternate')
    assert.equal(restored.buffer.active.getLine(0)?.translateToString(true), '中文色块 ███')
    assert.equal(restored.buffer.active.getLine(0)?.getCell(0)?.getFgColor(), 1)
    assert.equal(restored.buffer.active.cursorX, 8)
    assert.equal(restored.buffer.active.cursorY, 4)
    assert.equal(restored.modes.bracketedPasteMode, true)
    assert.ok(snapshot.output.endsWith('\x1B[?25l'))
    assert.ok(Buffer.byteLength(snapshot.output) < 256 * 1024)
    const attaching = service.attach(ref)
    output('续')
    const before = await attaching
    assert.equal(before.outputSequence, 3)
    assert.ok(!before.output.includes('续'))
    const after = await service.attach(ref)
    assert.equal(after.outputSequence, 4)
    assert.ok(after.output.includes('续'))
  } finally {
    restored.dispose()
    await service.dispose()
  }
})
