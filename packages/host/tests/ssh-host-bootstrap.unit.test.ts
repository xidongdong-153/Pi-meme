import { createHash, randomBytes } from 'node:crypto'
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { create as createTar, Header } from 'tar'
import { afterEach, expect, test, vi } from 'vitest'
import { createSshHostPreparer, sshHostTarget, validateHostArchive } from '../src/ssh-host-bootstrap'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-ssh-package-'))
  roots.push(root)
  const bundle = path.join(root, 'pi-meme-host')
  await mkdir(path.join(bundle, 'runtime/bin'), { recursive: true })
  await mkdir(path.join(bundle, 'apps/server/dist'), { recursive: true })
  await writeFile(path.join(bundle, 'runtime/bin/node'), 'fixture', { mode: 0o755 })
  await writeFile(path.join(bundle, 'apps/server/dist/ssh-bootstrap.js'), 'fixture')
  await writeFile(
    path.join(bundle, 'release.json'),
    JSON.stringify({ version: '1.2.3', platform: 'linux', arch: 'x64' }),
  )
  const file = path.join(root, 'host.tar.gz')
  await createTar({ file, gzip: true, cwd: root }, ['pi-meme-host'])
  return { root, file, bundle }
}
const validate = vi.fn(async () => ({ executable: '/fixture/ssh', args: ['-T'] }))
const ready = { protocolVersion: 1, version: '1.2.3', port: 41000, hostId: 'fixture-host', token: 'fixture-secret' }
const absent = JSON.stringify({ status: 'absent' })
const existing = JSON.stringify({ status: 'found', port: ready.port, hostId: ready.hostId, token: ready.token })

test.each([undefined, 'not-a-release'])('已有 Host 直连跳过发行版本 %s、安装依赖与下载', async (version) => {
  const command = vi.fn().mockResolvedValue(existing)
  const request = vi.fn()
  const steps: string[] = []
  const prepare = createSshHostPreparer({ version, validate, command, fetch: request })
  const result = await prepare({ target: 'dev' }, new AbortController().signal, (step) => steps.push(step))
  expect(result).toEqual({ port: ready.port, hostId: ready.hostId, token: ready.token })
  expect(command).toHaveBeenCalledTimes(1)
  expect(command.mock.calls[0][2]).toContain('python3 -I -')
  expect(request).not.toHaveBeenCalled()
  expect(steps).toEqual(['checking'])
})

test('仅在明确没有运行实例后才检查安装所需发行版本', async () => {
  const command = vi.fn().mockResolvedValue(absent)
  const request = vi.fn()
  const prepare = createSshHostPreparer({ validate, command, fetch: request })
  await expect(prepare({ target: 'dev' }, new AbortController().signal, () => {})).rejects.toMatchObject({
    code: 'host-release',
  })
  expect(command).toHaveBeenCalledTimes(1)
  expect(request).not.toHaveBeenCalled()
})

test.each([
  'host-probe-python',
  'host-probe-runtime',
  'host-probe-identity',
  'host-probe-credentials',
  'host-probe-running',
])('探测失败 %s 不进入安装，也不回显原始响应', async (code) => {
  const command = vi.fn().mockResolvedValue(JSON.stringify({ status: 'error', code, message: 'private-secret' }))
  const request = vi.fn()
  const prepare = createSshHostPreparer({ version: '1.2.3', validate, command, fetch: request })
  const failure = await prepare({ target: 'dev' }, new AbortController().signal, () => {}).catch((cause) => cause)
  expect(failure).toMatchObject({ code })
  expect(failure.message).not.toContain('private-secret')
  expect(command).toHaveBeenCalledTimes(1)
  expect(request).not.toHaveBeenCalled()
})

test('探测期间取消后不返回连接或进入安装', async () => {
  const controller = new AbortController()
  const command = vi.fn(async () => {
    controller.abort()
    return existing
  })
  const request = vi.fn()
  const prepare = createSshHostPreparer({ version: '1.2.3', validate, command, fetch: request })
  await expect(prepare({ target: 'dev' }, controller.signal, () => {})).rejects.toThrow()
  expect(command).toHaveBeenCalledTimes(1)
  expect(request).not.toHaveBeenCalled()
})

test('平台检测按真实SSH环境判断，不支持的系统直接失败', () => {
  expect(sshHostTarget('Darwin\narm64\n24.0.0\n')).toBe('macos-arm64')
  expect(sshHostTarget('Linux\nx86_64\n6.8.0-microsoft-standard-WSL2\n')).toBe('linux-x64')
  expect(() => sshHostTarget('Darwin\nx86_64\n24.0.0')).toThrow(/仅支持/)
  expect(() => sshHostTarget('Darwin\narm64\n23.0.0')).toThrow(/仅支持/)
  expect(() => sshHostTarget('banner\nLinux\nx86_64\n6.8.0')).toThrow(/无法识别/)
})

test('已安装目标直接bootstrap，私有响应版本和协议必须匹配', async () => {
  const command = vi
    .fn()
    .mockResolvedValueOnce(absent)
    .mockResolvedValueOnce('Linux\nx86_64\n6.8.0\n')
    .mockResolvedValueOnce('ready')
    .mockResolvedValueOnce(JSON.stringify(ready))
  const request = vi.fn()
  const prepare = createSshHostPreparer({ version: '1.2.3', validate, command, fetch: request })
  const steps: string[] = []
  const result = await prepare({ target: 'dev' }, new AbortController().signal, (step) => steps.push(step))
  expect(result).toEqual({ port: 41000, hostId: 'fixture-host', token: 'fixture-secret' })
  expect(steps).toEqual(['checking', 'starting'])
  expect(request).not.toHaveBeenCalled()
  expect(command.mock.calls[3][2]).toContain('/1.2.3/linux-x64/')
  expect(command.mock.calls[3][3]).toEqual({ text: '{"protocolVersion":1}' })
  expect(JSON.stringify(command.mock.calls)).not.toContain('fixture-secret')
})

test('没有安装时下载固定版本、校验、规范打包后传输，再启动', async () => {
  const { root, file } = await fixture()
  const bytes = await readFile(file)
  const checksum = createHash('sha256').update(bytes).digest('hex')
  const request = vi.fn(async (url: string | URL | Request) =>
    String(url).endsWith('SHA256SUMS')
      ? new Response(`${checksum}  pi-meme-host-1.2.3-linux-x64.tar.gz\n`)
      : new Response(bytes),
  ) as unknown as typeof fetch
  let transferred = false
  const command = vi.fn(async (_ssh, _target, script: string, input) => {
    if (script.includes('python3')) return absent
    if (script.includes('uname')) return 'Linux\nx86_64\n6.8.0\n'
    if (script.includes('printf ready')) return 'missing'
    if (input && 'file' in input) {
      transferred = true
      const check = path.join(root, 'transferred')
      await mkdir(check)
      await validateHostArchive(input.file, check, '1.2.3', 'linux-x64')
      expect(script).toContain('renameSync')
      return ''
    }
    return JSON.stringify(ready)
  })
  const prepare = createSshHostPreparer({
    version: '1.2.3',
    cacheDirectory: path.join(root, 'cache'),
    validate,
    command,
    fetch: request,
  })
  const steps: string[] = []
  await prepare({ target: 'dev' }, new AbortController().signal, (step) => steps.push(step))
  expect(transferred).toBe(true)
  expect(steps).toEqual(['checking', 'installing', 'starting'])
  expect(request).toHaveBeenCalledTimes(2)
  expect(vi.mocked(request).mock.calls.every(([url]) => String(url).includes('/v1.2.3/'))).toBe(true)
})

test('校验失败不传输，不执行远端启动且不留下下载临时文件', async () => {
  const { root } = await fixture()
  const command = vi
    .fn()
    .mockResolvedValueOnce(absent)
    .mockResolvedValueOnce('Linux\nx86_64\n6.8.0')
    .mockResolvedValueOnce('missing')
  const request = vi.fn(
    async (url) =>
      new Response(
        String(url).endsWith('SHA256SUMS') ? `${'a'.repeat(64)}  pi-meme-host-1.2.3-linux-x64.tar.gz` : 'corrupted',
      ),
  )
  const prepare = createSshHostPreparer({
    version: '1.2.3',
    cacheDirectory: path.join(root, 'cache'),
    validate,
    command,
    fetch: request,
  })
  await expect(prepare({ target: 'dev' }, new AbortController().signal, () => {})).rejects.toThrow(/SHA256/)
  expect(command).toHaveBeenCalledTimes(3)
  const { readdir } = await import('node:fs/promises')
  expect(await readdir(path.join(root, 'cache'))).toEqual([])
})

test('发行站点停流会超时并标记可重试，不永久停留在准备中', async () => {
  const { root } = await fixture()
  const timeout = AbortSignal.timeout.bind(AbortSignal)
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => timeout(10))
  const request: typeof fetch = async (_url, options) =>
    new Promise((_resolve, reject) => {
      const signal = options?.signal
      if (signal?.aborted) reject(signal.reason)
      else signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  const command = vi
    .fn()
    .mockResolvedValueOnce(absent)
    .mockResolvedValueOnce('Linux\nx86_64\n6.8.0')
    .mockResolvedValueOnce('missing')
  const prepare = createSshHostPreparer({
    version: '1.2.3',
    cacheDirectory: path.join(root, 'cache'),
    validate,
    command,
    fetch: request,
  })
  await expect(prepare({ target: 'dev' }, new AbortController().signal, () => {})).rejects.toMatchObject({
    code: 'host-download',
    retryable: true,
  })
  expect(command).toHaveBeenCalledTimes(3)
})

test('旧发行包缺少 SSH 启动入口时返回可操作错误', async () => {
  const { root, file, bundle } = await fixture()
  await rm(path.join(bundle, 'apps/server/dist/ssh-bootstrap.js'))
  await createTar({ file, gzip: true, cwd: root }, ['pi-meme-host'])
  const check = path.join(root, 'missing-entry')
  await mkdir(check)
  await expect(validateHostArchive(file, check, '1.2.3', 'linux-x64')).rejects.toMatchObject({
    code: 'host-archive',
    message: '安装包缺少运行文件，请更新到包含 SSH 启动入口的版本',
  })
})

test('发行包内的硬链接可解压，包外硬链接仍拒绝', async () => {
  const { root, file, bundle } = await fixture()
  await link(path.join(bundle, 'runtime/bin/node'), path.join(bundle, 'runtime/bin/node-copy'))
  await createTar({ file, gzip: true, cwd: root }, ['pi-meme-host'])
  const check = path.join(root, 'hardlinks')
  await mkdir(check)
  await validateHostArchive(file, check, '1.2.3', 'linux-x64')
  const original = await stat(path.join(check, 'pi-meme-host/runtime/bin/node'))
  const copy = await stat(path.join(check, 'pi-meme-host/runtime/bin/node-copy'))
  expect(copy.ino).toBe(original.ino)

  const header = new Header({ path: 'pi-meme-host/escape', type: 'Link', linkpath: '../outside' })
  header.encode()
  await writeFile(file, Buffer.concat([header.block!, Buffer.alloc(1024)]))
  await expect(validateHostArchive(file, check, '1.2.3', 'linux-x64')).rejects.toThrow(/越界/)
})

test('包内链接不能越过根目录，版本不符不能被发布', async () => {
  const { root, file, bundle } = await fixture()
  await symlink('../../outside', path.join(bundle, 'escape'))
  await createTar({ file, gzip: true, cwd: root }, ['pi-meme-host'])
  const check = path.join(root, 'check')
  await mkdir(check)
  await expect(validateHostArchive(file, check, '1.2.3', 'linux-x64')).rejects.toThrow(/越界/)
  await rm(path.join(bundle, 'escape'))
  await createTar({ file, gzip: true, cwd: root }, ['pi-meme-host'])
  await expect(validateHostArchive(file, check, '2.0.0', 'linux-x64')).rejects.toThrow(/版本或平台/)
})

test('私有响应无效时不会把token当作诊断回显', async () => {
  const command = vi
    .fn()
    .mockResolvedValueOnce(absent)
    .mockResolvedValueOnce('Linux\nx86_64\n6.8.0')
    .mockResolvedValueOnce('ready')
    .mockResolvedValueOnce(JSON.stringify({ ...ready, version: '0.0.0' }))
  const prepare = createSshHostPreparer({ version: '1.2.3', validate, command })
  await expect(prepare({ target: 'dev' }, new AbortController().signal, () => {})).rejects.toThrow(
    '远程服务准备响应与当前版本不匹配',
  )
})

test('远端提前关闭上传时保留SSH指纹错误，不被EPIPE覆盖', async () => {
  const { root, file, bundle } = await fixture()
  await writeFile(path.join(bundle, 'runtime/bin/node'), randomBytes(2 * 1024 * 1024))
  await createTar({ file, gzip: true, cwd: root }, ['pi-meme-host'])
  const bytes = await readFile(file)
  const checksum = createHash('sha256').update(bytes).digest('hex')
  const request = vi.fn(
    async (url) =>
      new Response(String(url).endsWith('SHA256SUMS') ? `${checksum}  pi-meme-host-1.2.3-linux-x64.tar.gz` : bytes),
  )
  const fakeSsh = `const fs=require('node:fs');const command=process.argv.at(-1);if(command.includes('python3')){process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('{"status":"absent"}'))}else if(command.includes('uname'))process.stdout.write('Linux\\nx86_64\\n6.8.0\\n');else if(command.includes('printf ready'))process.stdout.write('missing');else {fs.closeSync(0);process.stderr.write('Host key verification failed.');setTimeout(()=>process.exit(255),100)}`
  const prepare = createSshHostPreparer({
    version: '1.2.3',
    cacheDirectory: path.join(root, 'cache'),
    fetch: request,
    validate: async () => ({ executable: process.execPath, args: ['-e', fakeSsh] }),
  })
  await expect(prepare({ target: 'fixture' }, new AbortController().signal, () => {})).rejects.toMatchObject({
    code: 'host-key',
  })
})

test('已经取消的准备不连接目标', async () => {
  const controller = new AbortController()
  controller.abort()
  const command = vi.fn()
  const prepare = createSshHostPreparer({
    version: '1.2.3',
    validate: async (_connection, signal) => {
      signal.throwIfAborted()
      return { executable: '/fixture/ssh', args: [] }
    },
    command,
  })
  await expect(prepare({ target: 'dev' }, controller.signal, () => {})).rejects.toThrow()
  expect(command).not.toHaveBeenCalled()
})
