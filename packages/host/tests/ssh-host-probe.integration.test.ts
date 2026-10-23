import { spawn, spawnSync } from 'node:child_process'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { defaultHostPort } from '@pi-meme/contracts/host-runtime'
import { parseSshHostProbe, sshHostProbeScript } from '../src/ssh-host-probe'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const python = spawnSync('python3', ['-I', '--version'], { encoding: 'utf8' })

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('测试 HTTP 端口不可用')
  return address.port
}

async function fixture() {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'pi-ssh-probe-')))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const root = path.join(home, '.pi-meme')
  const runtime = path.join(home, '.local/state/pi-meme/ssh-host')
  const descriptorFile = path.join(runtime, 'runtime.json')
  const authFile = path.join(root, 'credentials/auth.json')
  await mkdir(path.dirname(authFile), { recursive: true, mode: 0o700 })
  await mkdir(runtime, { recursive: true, mode: 0o700 })
  await writeFile(path.join(root, 'host-id'), 'fixture-host')
  await writeFile(authFile, JSON.stringify({ 'host:token': 'short', 'other:token': 'never-print-this-secret' }), {
    mode: 0o600,
  })
  let status: unknown = {
    product: 'pi-meme',
    runtimeProtocolVersion: 1,
    hostId: 'fixture-host',
    instanceId: 'fixture-instance',
    dataRoot: root,
    owner: 'desktop',
  }
  let mode: 'json' | 'redirect' | 'timeout' | 'large' | 'invalid' | 'null' = 'json'
  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(request.url ?? '')
    if (mode === 'timeout') return
    if (mode === 'redirect') {
      response.writeHead(302, { Location: '/secret-login' })
      response.end()
    } else if (mode === 'large') response.end(' '.repeat(65537))
    else if (mode === 'invalid') response.end('never-print-this-secret')
    else if (mode === 'null') response.end('null')
    else response.end(JSON.stringify(status))
  })
  const port = await listen(server)
  const descriptor = {
    protocolVersion: 1,
    pid: 999999,
    port,
    hostId: 'fixture-host',
    instanceId: 'fixture-instance',
    version: 'old-version-ignored',
  }
  await writeFile(descriptorFile, JSON.stringify(descriptor), { mode: 0o600 })
  const probe = async (options: { defaultPort?: number; env?: NodeJS.ProcessEnv; otherOwner?: boolean } = {}) => {
    // 仅替换固定常量，生产脚本不开放端口配置；所有测试都不接触真实默认 Host。
    let script = sshHostProbeScript.replace(
      `DEFAULT_PORT = ${defaultHostPort}`,
      `DEFAULT_PORT = ${options.defaultPort ?? port}`,
    )
    if (options.otherOwner) script = script.replace('import os\n', 'import os\nos.getuid = lambda: -1\n')
    expect(script).not.toContain(`DEFAULT_PORT = ${defaultHostPort}\n`)
    const child = spawn('python3', ['-I', '-'], {
      env: { ...process.env, ...options.env, HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (value: Buffer) => (stdout += value.toString()))
    child.stderr.on('data', (value: Buffer) => (stderr += value.toString()))
    const timer = setTimeout(() => child.kill('SIGKILL'), 7000)
    try {
      const result = new Promise<number | null>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', resolve)
      })
      child.stdin.end(script)
      expect(await result).toBe(0)
      expect(stderr).toBe('')
      expect(stdout.trim().split('\n')).toHaveLength(1)
      return { stdout, result: JSON.parse(stdout) as unknown }
    } finally {
      clearTimeout(timer)
    }
  }
  const close = async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  return {
    home,
    root,
    runtime,
    descriptorFile,
    descriptor,
    authFile,
    port,
    probe,
    requests,
    close,
    setStatus: (value: unknown) => (status = value),
    setMode: (value: typeof mode) => (mode = value),
  }
}

async function snapshot(directory: string): Promise<unknown[]> {
  const result: unknown[] = []
  for (const name of (await readdir(directory, { recursive: true })).sort()) {
    const file = path.join(directory, name)
    const info = await lstat(file)
    result.push([name, info.mode, info.uid, info.mtimeMs, info.isFile() ? await readFile(file, 'utf8') : null])
  }
  return result
}

describe.skipIf(python.status !== 0)('真实 Python 3 只读 Host 探测（需要系统 python3）', () => {
  test('复用不同发行版本的已有 Host，仅输出 Host token，探测不修改任何文件', async () => {
    const f = await fixture()
    const before = await snapshot(f.home)
    const { stdout, result } = await f.probe()
    expect(result).toEqual({ status: 'found', port: f.port, hostId: 'fixture-host', token: 'short' })
    expect(parseSshHostProbe(stdout)).toEqual({ port: f.port, hostId: 'fixture-host', token: 'short' })
    expect(stdout).not.toContain('never-print-this-secret')
    expect(await snapshot(f.home)).toEqual(before)
    expect(f.requests).toEqual(['/api/status'])
  })

  test('运行描述随机端口优先于默认候选', async () => {
    const f = await fixture()
    let fallbackRequests = 0
    const fallback = await listen(
      createServer((_request, response) => {
        fallbackRequests++
        response.end('{}')
      }),
    )
    expect((await f.probe({ defaultPort: fallback })).result).toMatchObject({ status: 'found', port: f.port })
    expect(fallbackRequests).toBe(0)
  })

  test('运行目录不存在时仍探测默认候选，不创建运行目录', async () => {
    const f = await fixture()
    await rm(f.runtime, { recursive: true })
    expect((await f.probe()).result).toMatchObject({ status: 'found', port: f.port })
    await expect(lstat(f.runtime)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('描述候选拒连后探测默认候选，不用旧描述约束新实例', async () => {
    const f = await fixture()
    const unusedServer = createServer()
    const refusedPort = await listen(unusedServer)
    await new Promise<void>((resolve) => unusedServer.close(() => resolve()))
    await writeFile(f.descriptorFile, JSON.stringify({ ...f.descriptor, port: refusedPort, instanceId: 'stale' }))
    expect((await f.probe()).result).toMatchObject({ status: 'found', port: f.port })
  })

  test.each([
    ['目录权限', 'directory'],
    ['文件权限', 'file'],
    ['符号链接', 'symlink'],
    ['损坏JSON', 'json'],
    ['非法端口', 'port'],
    ['布尔端口', 'boolean'],
    ['缺少身份', 'identity'],
  ])('运行描述无效直接失败：%s', async (_name, kind) => {
    const f = await fixture()
    if (kind === 'directory') await chmod(f.runtime, 0o755)
    if (kind === 'file') await chmod(f.descriptorFile, 0o644)
    if (kind === 'symlink') {
      const target = path.join(f.home, 'descriptor-target')
      await writeFile(target, JSON.stringify(f.descriptor), { mode: 0o600 })
      await rm(f.descriptorFile)
      await symlink(target, f.descriptorFile)
    }
    if (kind === 'json') await writeFile(f.descriptorFile, '{"token":"never-print-this-secret"')
    if (kind === 'port') await writeFile(f.descriptorFile, JSON.stringify({ ...f.descriptor, port: 65536 }))
    if (kind === 'boolean') await writeFile(f.descriptorFile, JSON.stringify({ ...f.descriptor, port: true }))
    if (kind === 'identity') await writeFile(f.descriptorFile, JSON.stringify({ ...f.descriptor, hostId: '' }))
    const { stdout, result } = await f.probe()
    expect(result).toEqual({ status: 'error', code: 'host-probe-runtime' })
    expect(stdout).not.toContain('never-print-this-secret')
    expect(f.requests).toEqual([])
  })

  test('运行目录所有者不匹配时拒绝读取', async () => {
    const f = await fixture()
    // 只在测试脚本内模拟不同 uid，避免要求 chown 权限或修改真实用户文件。
    expect((await f.probe({ otherOwner: true })).result).toEqual({ status: 'error', code: 'host-probe-runtime' })
    expect(f.requests).toEqual([])
  })

  test.each([
    { product: 'other-product' },
    { runtimeProtocolVersion: 2 },
    { runtimeProtocolVersion: true },
    { hostId: 'other-host' },
    { instanceId: 'other-instance' },
    { owner: 'other-owner' },
    { dataRoot: '/other-root' },
  ])('状态身份不匹配时失败：%j', async (patch) => {
    const f = await fixture()
    f.setStatus({
      product: 'pi-meme',
      runtimeProtocolVersion: 1,
      hostId: 'fixture-host',
      instanceId: 'fixture-instance',
      owner: 'server',
      dataRoot: f.root,
      ...patch,
    })
    await rm(f.authFile)
    expect((await f.probe()).result).toEqual({ status: 'error', code: 'host-probe-identity' })
  })

  test('host-id文件不匹配时在读取凭据前失败', async () => {
    const f = await fixture()
    await writeFile(path.join(f.root, 'host-id'), 'other-host')
    await rm(f.authFile)
    expect((await f.probe()).result).toEqual({ status: 'error', code: 'host-probe-identity' })
  })

  test.each(['permissions', 'symlink', 'json', 'missing', 'empty', 'large-token', 'large-file'])(
    '凭据无效时安全失败：%s',
    async (kind) => {
      const f = await fixture()
      if (kind === 'permissions') await chmod(f.authFile, 0o644)
      if (kind === 'symlink') {
        const target = path.join(f.home, 'credentials-target')
        await writeFile(target, '{"host:token":"never-print-this-secret"}', { mode: 0o600 })
        await rm(f.authFile)
        await symlink(target, f.authFile)
      }
      if (kind === 'json') await writeFile(f.authFile, '{"host:token":"never-print-this-secret"')
      if (kind === 'missing') await rm(f.authFile)
      if (kind === 'empty') await writeFile(f.authFile, '{"host:token":" "}')
      if (kind === 'large-token') await writeFile(f.authFile, JSON.stringify({ 'host:token': 'x'.repeat(4097) }))
      if (kind === 'large-file') await writeFile(f.authFile, ' '.repeat(1024 * 1024 + 1))
      const { stdout, result } = await f.probe()
      expect(result).toEqual({ status: 'error', code: 'host-probe-credentials' })
      expect(stdout).not.toContain('never-print-this-secret')
      expect(() => parseSshHostProbe(stdout)).toThrow(/凭据无效/)
    },
  )

  test('忽略外部 HTTP 代理和 Python 环境注入', async () => {
    const f = await fixture()
    let proxyRequests = 0
    const proxyPort = await listen(
      createServer((_request, response) => {
        proxyRequests++
        response.end('never-print-this-secret')
      }),
    )
    const proxy = `http://127.0.0.1:${proxyPort}`
    const { result } = await f.probe({
      env: {
        http_proxy: proxy,
        HTTP_PROXY: proxy,
        ALL_PROXY: proxy,
        NO_PROXY: '',
        no_proxy: '',
        PYTHONPATH: f.home,
        PYTHONSTARTUP: path.join(f.home, 'must-not-run.py'),
      },
    })
    expect(result).toMatchObject({ status: 'found' })
    expect(proxyRequests).toBe(0)
  })

  test.each(['redirect', 'large', 'invalid', 'null'] as const)('HTTP异常不回退、不泄漏响应：%s', async (mode) => {
    const f = await fixture()
    f.setMode(mode)
    let fallbackRequests = 0
    const defaultPort = await listen(
      createServer((_request, response) => {
        fallbackRequests++
        response.end('{}')
      }),
    )
    const { stdout, result } = await f.probe({ defaultPort })
    expect(result).toEqual({ status: 'error', code: 'host-probe-http' })
    expect(stdout).not.toContain('never-print-this-secret')
    expect(f.requests).toEqual(['/api/status'])
    expect(fallbackRequests).toBe(0)
  })

  test('HTTP超时明确失败而非继续安装', async () => {
    const f = await fixture()
    f.setMode('timeout')
    const started = Date.now()
    expect((await f.probe()).result).toEqual({ status: 'error', code: 'host-probe-http' })
    expect(Date.now() - started).toBeLessThan(5000)
  })

  test.each(['absent', 'fresh', 'stale', 'invalid'] as const)('候选都拒连时检查锁：%s', async (kind) => {
    const f = await fixture()
    await f.close()
    await rm(f.authFile)
    const lock = path.join(f.root, 'host.lock')
    if (kind === 'invalid') await writeFile(lock, 'never-print-this-secret')
    else if (kind !== 'absent') {
      await mkdir(lock)
      if (kind === 'stale') await utimes(lock, new Date(0), new Date(0))
    }
    const before = await snapshot(f.home)
    const { result } = await f.probe()
    expect(result).toEqual(
      kind === 'fresh'
        ? { status: 'error', code: 'host-probe-running' }
        : kind === 'invalid'
          ? { status: 'error', code: 'host-probe-lock' }
          : { status: 'absent' },
    )
    expect(await snapshot(f.home)).toEqual(before)
  })
})

test('解析器只返回固定中文错误，不泄漏原始输出、异常或未知错误码', () => {
  for (const output of [
    'never-print-this-secret',
    '{"status":"error","code":"never-print-this-secret"}',
    '{"status":"found","port":31415,"hostId":"host","token":""}',
    '{"status":"absent","token":"never-print-this-secret"}',
    'x'.repeat(65537),
  ]) {
    expect(() => parseSshHostProbe(output)).toThrow('远端 Host 探测没有返回有效结果，请检查 SSH 登录环境')
  }
  expect(() => parseSshHostProbe('{"status":"error","code":"host-probe-python"}')).toThrow(/Python 3/)
  expect(parseSshHostProbe('{"status":"absent"}')).toBeNull()
})
