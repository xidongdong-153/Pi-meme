import assert from 'node:assert/strict'
import { beforeEach, test, vi } from 'vitest'
import { access, readFile, realpath } from 'node:fs/promises'
import { linuxSandboxLaunch } from '../src/sdk/linux-sandbox'

vi.mock('node:fs/promises', () => ({ access: vi.fn(), readFile: vi.fn(), realpath: vi.fn() }))

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(access).mockResolvedValue(undefined)
  vi.mocked(readFile).mockResolvedValue('')
  vi.mocked(realpath).mockImplementation(async (value) => String(value))
})

const options = {
  mode: 'workspace-write' as const,
  cwd: '/tmp/project',
  temporary: '/tmp/session-temp',
  agentDir: '/tmp/host/pi',
  dataRoot: '/tmp/host',
}

test('Linux 临时数据目录仅恢复附件只读挂载，不开放凭据和其他会话', async () => {
  const launch = await linuxSandboxLaunch(options)
  const bindings = launch.args.flatMap((arg, index) =>
    arg === '--ro-bind' || arg === '--bind' ? [launch.args.slice(index, index + 3)] : [],
  )
  assert.ok(
    bindings.some(
      (entry) =>
        JSON.stringify(entry) === JSON.stringify(['--ro-bind', '/tmp/host/attachments', '/tmp/host/attachments']),
    ),
  )
  assert.ok(!bindings.some((entry) => entry[1] === '/tmp/host'))
  assert.ok(!bindings.some((entry) => entry[0] === '--bind' && entry[1] === '/tmp/host/attachments'))
})

test('Linux 附件目录不存在时保持原沙箱，不挂载符号链接目标', async () => {
  vi.mocked(realpath).mockImplementation(async (value) => {
    if (value === '/tmp/host/attachments') throw Object.assign(new Error('不存在'), { code: 'ENOENT' })
    return String(value)
  })
  assert.ok(!(await linuxSandboxLaunch(options)).args.includes('/tmp/host/attachments'))
  vi.mocked(realpath).mockImplementation(async (value) =>
    value === '/tmp/host/attachments' ? '/tmp/secret' : String(value),
  )
  await assert.rejects(linuxSandboxLaunch(options), /符号链接/)
})
