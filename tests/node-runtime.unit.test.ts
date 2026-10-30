import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, test, vi } from 'vitest'
import { prepareNodeRuntime } from '../scripts/node-runtime.mjs'
import { nodeVersion } from '../scripts/release.mjs'

const mocks = vi.hoisted(() => ({ extract: vi.fn() }))
vi.mock('node:child_process', () => ({ execFileSync: mocks.extract }))
afterEach(() => vi.unstubAllGlobals())

test.each([
  { platform: 'win32' as const, archivePlatform: 'win', binary: 'node.exe', extension: 'zip' },
  { platform: 'darwin' as const, archivePlatform: 'darwin', binary: 'bin/node', extension: 'tar.gz' },
  { platform: 'linux' as const, archivePlatform: 'linux', binary: 'bin/node', extension: 'tar.gz' },
])('$platform 运行时按官方归档名称校验并复制可执行文件', async (target) => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-node-test-'))
  const destination = path.join(root, 'runtime with spaces')
  const distribution = `node-v${nodeVersion}-${target.archivePlatform}-x64`
  const archive = `${distribution}.${target.extension}`
  const payload = Buffer.from('runtime archive')
  const hash = createHash('sha256').update(payload).digest('hex')
  const fetchMock = vi.fn(
    async (url: string) => new Response(url.endsWith('SHASUMS256.txt') ? `${hash}  ${archive}\n` : payload),
  )
  vi.stubGlobal('fetch', fetchMock)
  mocks.extract.mockImplementation((_command: string, args: string[]) => {
    const directory = path.join(args[3], distribution)
    mkdirSync(path.dirname(path.join(directory, target.binary)), { recursive: true })
    writeFileSync(path.join(directory, target.binary), 'node binary')
    writeFileSync(path.join(directory, 'LICENSE'), 'Node license')
  })
  try {
    await prepareNodeRuntime(destination, target.platform, 'x64')
    assert.ok(fetchMock.mock.calls.some(([url]) => url.endsWith(`/${archive}`)))
    assert.equal(await readFile(path.join(destination, 'bin', path.basename(target.binary)), 'utf8'), 'node binary')
    assert.equal(await readFile(path.join(destination, 'LICENSE'), 'utf8'), 'Node license')
    assert.equal(JSON.parse(await readFile(path.join(destination, 'runtime.json'), 'utf8')).sha256, hash)
    assert.ok((await readFile(path.join(destination, 'restricted-entry.mjs'), 'utf8')).length > 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Windows 运行时校验失败时不解压、不写入目标目录', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-node-test-'))
  const destination = path.join(root, 'runtime')
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url: string) =>
        new Response(
          url.endsWith('SHASUMS256.txt') ? `${'0'.repeat(64)}  node-v${nodeVersion}-win-x64.zip\n` : 'invalid archive',
        ),
    ),
  )
  mocks.extract.mockClear()
  try {
    await assert.rejects(prepareNodeRuntime(destination, 'win32', 'x64'), /SHA256 校验失败/)
    assert.equal(mocks.extract.mock.calls.length, 0)
    await assert.rejects(readFile(path.join(destination, 'runtime.json')), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
