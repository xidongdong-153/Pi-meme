import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'vitest'
import { WindowsCommandProcess } from '@pi-meme/windows-native/process'
import {
  findSshExecutable,
  spawnSshProcess,
  stopChild,
  validateSshConnection,
  createSshTunnelStarter,
} from '../src/ssh-tunnels'
import { createSshHostPreparer } from '../src/ssh-host-bootstrap'

const windows = process.platform === 'win32'

test(
  'Windows 原生 OpenSSH 连接真实 Linux Host，重连、认证失败和取消后释放隧道',
  { skip: !windows || !process.env.PI_MEME_SSH_ACCEPTANCE_FIXTURE, timeout: 60000 },
  async () => {
    const fixture = JSON.parse(await readFile(process.env.PI_MEME_SSH_ACCEPTANCE_FIXTURE!, 'utf8')) as {
      configFile: string
      identityFile: string
      target: string
      port: number
    }
    const connection = { target: fixture.target, port: fixture.port, identityFile: fixture.identityFile }
    const validate = (target: Parameters<typeof validateSshConnection>[0], signal: AbortSignal) =>
      validateSshConnection(target, signal, { configFile: fixture.configFile })
    const prepare = createSshHostPreparer({ validate, version: '0.1.0-beta.12' })
    const start = createSshTunnelStarter({ configFile: fixture.configFile })
    const steps: string[] = []
    const controller = new AbortController()
    const prepared = await prepare(connection, controller.signal, (step) => steps.push(step))
    assert.equal(steps[0], 'checking')
    assert.ok(steps.every((step) => ['checking', 'starting'].includes(step)))
    if (process.env.PI_MEME_SSH_ACCEPTANCE_FRESH === '1') assert.deepEqual(steps, ['checking', 'starting'])
    for (const abort of [false, true]) {
      const active = new AbortController()
      const tunnel = await start(connection, prepared.port, active.signal)
      try {
        const status = await fetch(`${tunnel.endpoint}/api/status`).then((response) => response.json())
        assert.equal(status.hostId, prepared.hostId)
        const login = await fetch(`${tunnel.endpoint}/api/auth`, {
          method: 'POST',
          body: JSON.stringify({ token: prepared.token }),
        })
        assert.equal(login.status, 200)
        assert.ok(login.headers.get('set-cookie'))
        if (abort) active.abort(new Error('验证取消'))
        else await tunnel.stop()
        await tunnel.closed
        await assert.rejects(() => fetch(`${tunnel.endpoint}/api/status`))
      } finally {
        await tunnel.stop()
      }
    }
    const reused = await prepare(connection, controller.signal, () => {})
    assert.equal(reused.hostId, prepared.hostId)
    assert.equal(reused.port, prepared.port)
    await assert.rejects(
      () => start({ ...connection, target: `pi-missing-user@${fixture.target}` }, prepared.port, controller.signal),
      (error: unknown) => (error as { code?: string }).code === 'ssh-auth',
    )
  },
)
function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
test('Windows 系统 OpenSSH 正确读取中文空格配置及密钥路径', { skip: !windows }, async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'pi-ssh-原生 ')))
  try {
    const ssh = await findSshExecutable()
    assert.ok(ssh, '原生验收需要 Windows OpenSSH 客户端')
    const key = path.join(root, '中文 私钥')
    const file = path.join(root, '配置 config')
    await writeFile(file, `Host fixture\n HostName 127.0.0.1\n IdentityFile "${key.replaceAll('\\', '/')}"\n`)
    const child = await spawnSshProcess(ssh, ['-F', file, '-G', '--', 'fixture'], { stdio: ['ignore', 'pipe', 'pipe'] })
    assert.ok(child instanceof WindowsCommandProcess)
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    assert.equal((await child.native.completion).exitCode, 0)
    assert.match(output, /^hostname 127\.0\.0\.1$/m)
    assert.ok(output.includes(key.replaceAll('\\', '/')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Windows 取消 OpenSSH 时清理 ProxyCommand 和其 detached 子进程', { skip: !windows, timeout: 15000 }, async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'pi-ssh-proxy ')))
  let child: Awaited<ReturnType<typeof spawnSshProcess>> | undefined
  try {
    const ssh = await findSshExecutable()
    assert.ok(ssh, '原生验收需要 Windows OpenSSH 客户端')
    const marker = path.join(root, 'pids')
    const entry = path.join(root, 'proxy.cjs')
    await writeFile(
      entry,
      `const cp=require('node:child_process');const fs=require('node:fs');const c=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify([process.pid,c.pid]));setInterval(()=>{},1000)`,
    )
    const file = path.join(root, 'config')
    await writeFile(
      file,
      `Host fixture\n HostName fixture.invalid\n ProxyCommand "${process.execPath.replaceAll('\\', '/')}" "${entry.replaceAll('\\', '/')}"\n`,
    )
    child = await spawnSshProcess(ssh, ['-F', file, '-T', '-o', 'BatchMode=yes', '--', 'fixture'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let pids: number[] | undefined
    for (let index = 0; index < 200; index++) {
      try {
        pids = JSON.parse(await readFile(marker, 'utf8'))
        break
      } catch {
        await delay(25)
      }
    }
    assert.ok(pids?.length === 2, 'OpenSSH 未启动测试 ProxyCommand')
    assert.ok(pids.every(alive))
    await stopChild(child)
    assert.ok(pids.every((pid) => !alive(pid)))
  } finally {
    if (child) await stopChild(child)
    await rm(root, { recursive: true, force: true })
  }
})
