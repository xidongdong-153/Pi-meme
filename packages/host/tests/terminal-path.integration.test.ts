import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test, vi } from 'vitest'
import { TerminalService } from '../src/terminal-service'

test.skipIf(process.platform !== 'darwin')('原生 PTY 继承 Host PATH，直接执行临时用户工具', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-terminal-path-'))
  const bin = path.join(directory, 'user bin')
  let output = ''
  const state = { exited: false }
  const service = new TerminalService({
    hostId: 'path-fixture',
    resolveRoot: async () => directory,
    onEvent: (event) => {
      output += event.data ?? ''
      if (event.exitCode !== undefined) state.exited = true
    },
  })
  try {
    if (!service.supported) return t.skip('当前 Node.js 的 node-pty 原生模块不可用，需在对应运行时验收')
    await mkdir(bin)
    const tool = path.join(bin, 'pi-path-test-tool')
    await writeFile(tool, '#!/bin/sh\nprintf "临时终端工具已找到\\n"\n')
    await chmod(tool, 0o700)
    vi.stubEnv('HOME', directory)
    vi.stubEnv('ENV', undefined)
    vi.stubEnv('BASH_ENV', undefined)
    vi.stubEnv('PATH', `${bin}:/usr/bin:/bin`)
    const terminal = await service.open({ hostId: 'path-fixture', projectId: 'project' }, { command: '/bin/sh' })
    await service.input(terminal, 'pi-path-test-tool; exit\r')
    const deadline = Date.now() + 5000
    while (!state.exited) {
      if (Date.now() > deadline) throw new Error('等待临时终端工具执行超时')
      await delay(10)
    }
    assert.match(output, /临时终端工具已找到/)
    assert.ok(!output.includes('command not found'))
  } finally {
    await service.dispose()
    vi.unstubAllEnvs()
    await rm(directory, { recursive: true, force: true })
  }
})
