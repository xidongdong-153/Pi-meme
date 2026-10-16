import assert from 'node:assert/strict'
import { createSocket } from 'node:dgram'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { test } from 'vitest'
import { AccessSandbox } from '../src/sdk/access-sandbox'
import { unixSocketFilter, windowsMounts } from '../src/sdk/linux-sandbox'

test('Windows 驱动器按挂载信息识别，不拒绝普通 /mnt 目录', () => {
  const mounts =
    '1 0 0:1 / /mnt/project rw - ext4 /dev/sda rw\n2 0 0:2 / /mnt/windows\\040disk rw - 9p C:\\134 rw,aname=drvfs;path=C:\\;uid=1000\n3 0 0:3 / /usr/lib/wsl/drivers ro - 9p drivers ro,aname=drivers'
  assert.deepEqual(windowsMounts(mounts), ['/mnt/windows disk'])
  assert.throws(() => unixSocketFilter('riscv64'), /尚未验证/)
})

test('seccomp 校验原生、i386、x32 和未知 ABI，阻断 AF_UNIX 与 io_uring', () => {
  const evaluate = (architecture: 'x64' | 'arm64', audit: number, syscall: number, family = 1) => {
    const filter = unixSocketFilter(architecture)
    let accumulator = 0
    for (let index = 0; index < filter.length / 8; index++) {
      const code = filter.readUInt16LE(index * 8)
      const value = filter.readUInt32LE(index * 8 + 4)
      if (code === 0x20) accumulator = value === 4 ? audit : value === 0 ? syscall : family
      else if (code === 0x15 || code === 0x45) {
        const yes = code === 0x15 ? accumulator === value : (accumulator & value) !== 0
        index += filter[index * 8 + (yes ? 2 : 3)]!
      } else if (code === 0x06) return value
      else throw new Error(`未知 BPF 指令：${code}`)
    }
    throw new Error('过滤器未返回')
  }
  const denied = 0x00050001
  const allowed = 0x7fff0000
  assert.equal(evaluate('x64', 0xc000003e, 41), denied)
  assert.equal(evaluate('x64', 0xc000003e, 53), denied)
  assert.equal(evaluate('x64', 0xc000003e, 41, 2), allowed)
  assert.equal(evaluate('x64', 0xc000003e, 102), allowed)
  for (const syscall of [102, 359, 360, 425]) assert.equal(evaluate('x64', 0x40000003, syscall), denied)
  for (const syscall of [0x40000029, 425]) assert.equal(evaluate('x64', 0xc000003e, syscall), denied)
  assert.equal(evaluate('x64', 0x40000028, 41), 0x80000000)
  for (const syscall of [198, 199, 425]) assert.equal(evaluate('arm64', 0xc00000b7, syscall), denied)
  assert.equal(evaluate('arm64', 0xc00000b7, 198, 2), allowed)
  assert.equal(evaluate('arm64', 0x40000028, 281), 0x80000000)
})

test('Linux 沙箱保留 TCP、UDP、DNS，拒绝用户目录和 abstract Unix socket', async (t) => {
  if (process.platform !== 'linux') return t.skip('Linux 后端测试')
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'linux-sockets-')))
  const project = path.join(root, 'project')
  const temporary = path.join(root, 'temporary')
  await Promise.all([mkdir(project), mkdir(temporary)])
  const dnsServer = createSocket('udp4')
  dnsServer.on('message', (question, peer) => {
    const answer = Buffer.from(question)
    answer.writeUInt16BE(0x8180, 2)
    answer.writeUInt16BE(1, 6)
    dnsServer.send(
      Buffer.concat([answer, Buffer.from('c00c000100010000003c00047f000001', 'hex')]),
      peer.port,
      peer.address,
    )
  })
  await new Promise<void>((resolve) => dnsServer.bind(0, '127.0.0.1', resolve))
  const httpServer = createServer((_request, response) => response.end('linux-network'))
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const httpPort = (httpServer.address() as import('node:net').AddressInfo).port
  const dnsPort = dnsServer.address().port
  try {
    const sandbox = await AccessSandbox.create({
      mode: 'read-only',
      cwd: project,
      temporary,
      agentDir: path.join(root, 'agent'),
    })
    let output = ''
    const result = await sandbox.run(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict'
      import net from 'node:net'
      import dns from 'node:dns/promises'
      for (const address of ['/home/socket.sock', '\\0pi-sandbox-abstract']) {
        const socket = net.createConnection(address)
        await new Promise((resolve, reject) => {
          socket.once('connect', () => reject(new Error('不应连接成功')))
          socket.once('error', (error) => { try { assert.equal(error.code, 'EPERM'); resolve() } catch (cause) { reject(cause) } })
        })
      }
      dns.setServers(['127.0.0.1:${dnsPort}'])
      assert.deepEqual(await dns.resolve4('sandbox.test'), ['127.0.0.1'])
      assert.equal(await (await fetch('http://127.0.0.1:${httpPort}')).text(), 'linux-network')
      assert.ok((await (await import('node:fs/promises')).readFile('/etc/resolv.conf', 'utf8')).length)
    `,
      ],
      {
        cwd: project,
        timeout: 5,
        onData: (chunk) => {
          output += chunk.toString()
        },
      },
    )
    assert.equal(result.exitCode, 0, output)
  } finally {
    dnsServer.close()
    await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

test('WSL 隐藏 Windows 驱动器、互操作入口和宿主 /proc，复制 exe 也不能执行', async (t) => {
  if (process.platform !== 'linux' || !(await readFile('/proc/sys/kernel/osrelease', 'utf8')).includes('microsoft'))
    return t.skip('需要真实 WSL2')
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'wsl-interop-')))
  const project = path.join(root, 'project')
  const temporary = path.join(root, 'temporary')
  await Promise.all([mkdir(project), mkdir(temporary)])
  try {
    const drives = windowsMounts(await readFile('/proc/self/mountinfo', 'utf8'))
    assert.ok(drives.length, 'WSL 验收需要已挂载的 Windows 驱动器')
    const windowsCommand = path.join(drives[0]!, 'Windows/System32/cmd.exe')
    await copyFile(windowsCommand, path.join(project, 'copied.exe'))
    await assert.rejects(
      AccessSandbox.create({ mode: 'workspace-write', cwd: drives[0]!, temporary, agentDir: root }),
      /Linux 文件系统/,
    )
    const sandbox = await AccessSandbox.create({
      mode: 'workspace-write',
      cwd: project,
      temporary,
      agentDir: path.join(root, 'agent'),
    })
    let output = ''
    const run = (command: string) =>
      sandbox.run('/bin/bash', ['-c', command], {
        cwd: project,
        timeout: 5,
        onData: (chunk) => {
          output += chunk.toString()
        },
      })
    assert.notEqual((await run(`${JSON.stringify(windowsCommand)} /c exit 0`)).exitCode, 0)
    assert.notEqual((await run('./copied.exe /c exit 0')).exitCode, 0, output)
    assert.equal(
      (
        await run(
          `test ! -e /run/WSL && test ! -s /init && test ! -e /proc/${process.pid}/root && test -z "$WSL_INTEROP$WSLENV" && test ! -e /proc/self/fd/3`,
        )
      ).exitCode,
      0,
      output,
    )
    assert.equal((await run('echo linux > native.txt')).exitCode, 0)
    assert.equal(await readFile(path.join(project, 'native.txt'), 'utf8'), 'linux\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('父 Host 被 SIGKILL 后，bwrap 的 PID namespace 仍清理 setsid 后代', { timeout: 15000 }, async (t) => {
  if (process.platform !== 'linux') return t.skip('Linux 后端测试')
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'linux-parent-exit-')))
  const project = path.join(root, 'project')
  const temporary = path.join(root, 'temporary')
  await Promise.all([mkdir(project), mkdir(temporary)])
  const marker = path.join(project, 'marker')
  const module = fileURLToPath(new URL('../src/sdk/access-sandbox.ts', import.meta.url))
  const code = `import { AccessSandbox } from ${JSON.stringify(module)};
    const sandbox = await AccessSandbox.create(${JSON.stringify({ mode: 'workspace-write', cwd: project, temporary, agentDir: path.join(root, 'agent') })});
    await sandbox.run('/bin/bash', ['-c', ${JSON.stringify(`setsid /bin/bash -c 'while true; do echo tick >> ${marker}; sleep 0.05; done' & wait`)}], {cwd:${JSON.stringify(project)},onData:()=>{}});`
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
  try {
    for (let count = 0; count < 200; count++) {
      try {
        await readFile(marker)
        break
      } catch {
        await delay(10)
      }
    }
    assert.ok((await readFile(marker, 'utf8')).includes('tick'))
    child.kill('SIGKILL')
    await closed
    await delay(100)
    const stopped = await readFile(marker, 'utf8')
    await delay(200)
    assert.equal(await readFile(marker, 'utf8'), stopped)
  } finally {
    child.kill('SIGKILL')
    await closed
    await rm(root, { recursive: true, force: true })
  }
})
