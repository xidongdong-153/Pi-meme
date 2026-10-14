import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import process from 'node:process'
import xterm from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import type { MutationOptions, TerminalRef, TerminalSnapshot, WorkspaceRef } from '@pi-meme/contracts/app-host'
import type { ResolveWorkspaceRoot } from './workspace-files'

export type PtyProcess = {
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  kill: () => void
  onData: (listener: (data: string) => void) => { dispose: () => void }
  onExit: (listener: (event: { exitCode: number }) => void) => { dispose: () => void }
}
export type PtyModule = {
  spawn: (
    command: string,
    args: string[],
    options: { cwd: string; cols: number; rows: number; name: string; env: NodeJS.ProcessEnv },
  ) => PtyProcess
}
type TerminalRecord = {
  snapshot: TerminalSnapshot
  pty: PtyProcess
  screen: InstanceType<typeof xterm.Terminal>
  serializer: SerializeAddon
  parsedSequence: number
  cursorVisible: boolean
  pending: Set<(cause: Error) => void>
  owner: string
  listeners: Array<{ dispose: () => void }>
}
type TerminalOptions = {
  hostId: string
  resolveRoot: ResolveWorkspaceRoot
  onEvent: (event: { terminalId: string; data?: string; outputSequence?: number; exitCode?: number }) => void
  pty?: PtyModule | null
}
function loadPty(): PtyModule | null {
  try {
    const require = createRequire(typeof __filename === 'string' ? __filename : import.meta.url)
    return require('node-pty') as PtyModule
  } catch (cause) {
    console.error('node-pty 加载失败：', cause)
    return null
  }
}
function size(cols = 80, rows = 24) {
  if (![cols, rows].every((value) => Number.isInteger(value) && value >= 1 && value <= 1000))
    throw new Error('终端行列数必须是 1 到 1000 之间的整数')
  return { cols, rows }
}
export class TerminalService {
  private readonly terminals = new Map<string, TerminalRecord>()
  private readonly pty: PtyModule | null
  private disposed = false
  readonly supported: boolean
  constructor(private readonly options: TerminalOptions) {
    this.pty = options.pty === undefined ? loadPty() : options.pty
    this.supported = this.pty !== null
  }
  private record(ref: TerminalRef) {
    if (ref.hostId !== this.options.hostId) throw new Error('终端所属 Host 不匹配')
    const record = this.terminals.get(ref.terminalId)
    if (!record) throw new Error('终端不存在或已释放')
    return record
  }
  async open(
    root: WorkspaceRef,
    input: { command?: string; cols?: number; rows?: number },
    _options?: MutationOptions,
  ) {
    return this.openOwned(root, input, 'host')
  }
  async openOwned(
    root: WorkspaceRef,
    input: { command?: string; cols?: number; rows?: number },
    owner: string,
  ): Promise<TerminalSnapshot> {
    if (this.disposed) throw new Error('Host 终端服务已关闭')
    if (!this.pty) throw new Error('此 Host 的 node-pty 原生模块不可用，无法创建终端')
    if ([...this.terminals.values()].filter((entry) => !entry.snapshot.exited).length >= 16)
      throw new Error('Host 最多同时运行 16 个终端，请先关闭不用的实例')
    const cwd = await this.options.resolveRoot(root)
    const command = input.command ?? process.env.SHELL ?? (process.platform === 'win32' ? 'powershell.exe' : '/bin/sh')
    if (typeof command !== 'string' || !command.trim() || command.includes('\0')) throw new Error('终端命令无效')
    const dimensions = size(input.cols, input.rows)
    const pty = this.pty.spawn(command, [], {
      cwd,
      ...dimensions,
      name: 'xterm-256color',
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    })
    const snapshot: TerminalSnapshot = {
      hostId: this.options.hostId,
      terminalId: randomUUID(),
      cwd,
      ...dimensions,
      output: '',
      outputSequence: 0,
      exited: false,
    }
    const screen = new xterm.Terminal({ ...dimensions, allowProposedApi: true, scrollback: 1000 })
    const serializer = new SerializeAddon()
    screen.loadAddon(serializer)
    const record: TerminalRecord = {
      snapshot,
      pty,
      screen,
      serializer,
      parsedSequence: 0,
      cursorVisible: true,
      pending: new Set(),
      owner,
      listeners: [],
    }
    for (const final of ['h', 'l']) {
      screen.parser.registerCsiHandler({ prefix: '?', final }, (params) => {
        if (params.includes(25)) record.cursorVisible = final === 'h'
        return false
      })
    }
    screen.parser.registerEscHandler({ final: 'c' }, () => {
      record.cursorVisible = true
      return false
    })
    this.terminals.set(snapshot.terminalId, record)
    record.listeners.push(
      pty.onData((data) => {
        const outputSequence = ++snapshot.outputSequence
        screen.write(data, () => {
          record.parsedSequence = outputSequence
        })
        this.options.onEvent({ terminalId: snapshot.terminalId, data, outputSequence })
      }),
    )
    record.listeners.push(
      pty.onExit(({ exitCode }) => {
        snapshot.exited = true
        snapshot.exitCode = exitCode
        this.options.onEvent({ terminalId: snapshot.terminalId, exitCode })
        for (const listener of record.listeners) listener.dispose()
      }),
    )
    return structuredClone(snapshot)
  }
  async attach(ref: TerminalRef) {
    const record = this.record(ref)
    return this.flush(record, () => ({
      ...record.snapshot,
      cols: record.screen.cols,
      rows: record.screen.rows,
      output: record.serializer.serialize() + (record.cursorVisible ? '\x1B[?25h' : '\x1B[?25l'),
      outputSequence: record.parsedSequence,
    }))
  }
  private flush<T>(record: TerminalRecord, read: () => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      record.pending.add(reject)
      record.screen.write('', () => {
        record.pending.delete(reject)
        try {
          resolve(read())
        } catch (cause) {
          reject(cause)
        }
      })
    })
  }
  async input(ref: TerminalRef, data: string, _options?: MutationOptions) {
    const record = this.record(ref)
    if (record.snapshot.exited) throw new Error('终端进程已退出')
    if (typeof data !== 'string' || Buffer.byteLength(data) > 64 * 1024) throw new Error('单次终端输入不能超过 64 KiB')
    record.pty.write(data)
  }
  async resize(ref: TerminalRef, dimensions: { cols: number; rows: number }, _options?: MutationOptions) {
    const record = this.record(ref)
    if (record.snapshot.exited) throw new Error('终端进程已退出')
    const next = size(dimensions.cols, dimensions.rows)
    await this.flush(record, () => {
      if (record.snapshot.exited) throw new Error('终端进程已退出')
      record.screen.resize(next.cols, next.rows)
      Object.assign(record.snapshot, next)
      record.pty.resize(next.cols, next.rows)
    })
  }
  async close(ref: TerminalRef, _options?: MutationOptions) {
    const record = this.record(ref)
    if (!record.snapshot.exited) record.pty.kill()
    for (const listener of record.listeners) listener.dispose()
    for (const reject of record.pending) reject(new Error('终端已关闭'))
    record.pending.clear()
    record.screen.dispose()
    this.terminals.delete(ref.terminalId)
  }
  async closeOwner(owner: string) {
    for (const record of [...this.terminals.values()]) if (record.owner === owner) await this.close(record.snapshot)
  }
  async dispose() {
    this.disposed = true
    for (const record of [...this.terminals.values()]) await this.close(record.snapshot)
  }
}
