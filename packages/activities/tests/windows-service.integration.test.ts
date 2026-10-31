import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { ActivityService, type ActivityCaller } from '../src/server/service'
import { serviceProcessEnvironment, spawnManagedProcess } from '@pi-meme/pi-runtime/sdk/managed-process'

const windows = process.platform === 'win32'

test('Windows 缺少 pwsh 时使用真实 PowerShell 5.1，保留中文与退出码', { skip: !windows, timeout: 15000 }, async () => {
  const environment = { ...process.env }
  for (const key of Object.keys(environment)) if (key.toLowerCase() === 'path') delete environment[key]
  environment.PATH = [
    path.join(process.env.SystemRoot!, 'System32'),
    path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0'),
  ].join(';')
  const shell = pathToFileURL(path.resolve('packages/pi-runtime/src/sdk/command-shell.ts')).href
  const managed = pathToFileURL(path.resolve('packages/pi-runtime/src/sdk/managed-process.ts')).href
  const source = `const a=await import(${JSON.stringify(shell)});const b=await import(${JSON.stringify(managed)});console.log(await a.windowsShellDescription());const command=await a.shellCommand('[Console]::WriteLine("中文 5.1");exit 7');const child=await b.spawnManagedProcess(command.executable,command.args,{cwd:process.cwd(),env:b.serviceProcessEnvironment(),onData:chunk=>process.stdout.write(chunk)});console.log(JSON.stringify(await child.completion))`
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', source],
    { env: environment, windowsHide: true, timeout: 12000 },
  )
  assert.match(stdout, /PowerShell 5\.1\./)
  assert.match(stdout, /中文 5\.1/)
  assert.match(stdout, /"exitCode":7/)
})

test('Windows 受管进程清除大小写变体的 Node 注入环境变量', { skip: !windows }, async () => {
  let output = ''
  const child = await spawnManagedProcess(process.execPath, ['-e', 'console.log("safe")'], {
    cwd: process.cwd(),
    env: serviceProcessEnvironment({ node_options: '--invalid-native-test-option' }),
    onData: (chunk) => {
      output += chunk.toString()
    },
  })
  assert.equal((await child.completion).exitCode, 0)
  assert.equal(output.trim(), 'safe')
})
async function until(read: () => boolean) {
  for (let index = 0; index < 240; index++) {
    if (read()) return
    await delay(25)
  }
  throw new Error('等待 Windows 服务状态超时')
}
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'pi-服务验证 ')))
  const service = new ActivityService({ hostId: 'test-host', dataRoot: root, onChange: () => {} })
  const caller: ActivityCaller = {
    session: { hostId: 'test-host', sessionId: 'test-session' },
    cwd: root,
    agentDir: root,
    sourceName: '验证',
    accessMode: 'full-access',
  }
  return {
    root,
    service,
    caller,
    dispose: async () => {
      await service.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}
function command(source: string) {
  return `& '${process.execPath.replaceAll("'", "''")}' -e '${source.replaceAll("'", "''")}'`
}
function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('Windows PowerShell 服务输出中文，停止后清理 detached 子进程', { skip: !windows, timeout: 15000 }, async () => {
  const f = await fixture()
  try {
    const started = await f.service.start(f.caller, {
      name: '原生服务',
      requestId: 'tree',
      command: command(
        'const cp=require("node:child_process");const c=cp.spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"});console.log("中文输出 "+c.pid);setInterval(()=>{},1000)',
      ),
    })
    await until(() => f.service.logs(f.caller.session, started.serviceId).output.includes('中文输出'))
    const pid = Number(f.service.logs(f.caller.session, started.serviceId).output.match(/中文输出 (\d+)/)?.[1])
    assert.ok(pid > 0 && alive(pid))
    assert.equal((await f.service.stop(f.caller.session, started.serviceId)).status, 'stopped')
    assert.equal(alive(pid), false)
  } finally {
    await f.dispose()
  }
})

test('Windows 服务按 timeout 停止，有限命令保留原生退出码', { skip: !windows, timeout: 15000 }, async () => {
  const f = await fixture()
  try {
    const timed = await f.service.start(f.caller, {
      name: '超时服务',
      requestId: 'timeout',
      command: command('setInterval(()=>{},1000)'),
      timeout: 1,
    })
    await until(
      () =>
        f.service.list(f.caller.session).activities.find((item) => item.serviceId === timed.serviceId)?.status ===
        'stopped',
    )
    assert.equal(
      f.service.list(f.caller.session).activities.find((item) => item.serviceId === timed.serviceId)?.stopReason,
      '服务超时',
    )
    const finite = await f.service.start(f.caller, {
      name: '退出码',
      requestId: 'exit-code',
      command: command('process.exit(7)'),
    })
    await until(() =>
      Boolean(f.service.list(f.caller.session).activities.find((item) => item.serviceId === finite.serviceId)?.endedAt),
    )
    assert.equal(
      f.service.list(f.caller.session).activities.find((item) => item.serviceId === finite.serviceId)?.exitCode,
      7,
    )
  } finally {
    await f.dispose()
  }
})
