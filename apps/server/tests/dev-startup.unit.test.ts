import assert from 'node:assert/strict'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { test, vi } from 'vitest'

test.each([
  { port: undefined, dataRoot: undefined },
  { port: '31417', dataRoot: path.join(tmpdir(), 'pi-server-custom-dev') },
])('Server 开发入口隔离默认目录和端口，保留显式覆盖 $port', async ({ port, dataRoot }) => {
  vi.resetModules()
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('PI_MEME_PORT', port)
  vi.stubEnv('PI_MEME_DATA_ROOT', dataRoot)
  const start = vi.fn(() => ({ ...process.env }))
  vi.doMock('../src/main', () => {
    start()
    return {}
  })
  try {
    await import('../src/dev')
    assert.equal(start.mock.calls.length, 1)
    const env = start.mock.results[0].value
    assert.equal(env.NODE_ENV, 'development')
    assert.equal(env.PI_MEME_PORT, port ?? '3180')
    assert.equal(env.PI_MEME_DATA_ROOT, dataRoot ?? path.join(homedir(), '.pi-meme-dev'))
  } finally {
    vi.doUnmock('../src/main')
    vi.unstubAllEnvs()
    vi.resetModules()
  }
})
