import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkMcpServers } from '../src/server/diagnostics'
import { mcpReply } from '../../../tests/fixtures/mcp-server.mjs'

const fixture = fileURLToPath(new URL('../../../tests/fixtures/mcp-server.mjs', import.meta.url))

test('在隔离目录检查 HTTP 和 stdio 服务，关闭后清理服务进程', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-mcp-diagnostic-'))
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405).end()
      return
    }
    let body = ''
    for await (const chunk of request) body += chunk
    const reply = mcpReply(JSON.parse(body))
    if (!reply) {
      response.writeHead(202).end()
      return
    }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(reply))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const log = path.join(directory, 'server.log')
  const file = path.join(directory, 'mcp.json')
  try {
    const port = (server.address() as { port: number }).port
    await writeFile(
      file,
      JSON.stringify({
        mcpServers: {
          local: { command: process.execPath, args: [fixture, '--stdio'], env: { MCP_FIXTURE_LOG: log } },
          remote: { url: `http://127.0.0.1:${port}/mcp` },
        },
      }),
    )
    const result = await checkMcpServers(file)
    assert.equal(result.exitCode, 0, result.output)
    assert.equal(result.timedOut, false)
    assert.match(result.output, /local/)
    assert.match(result.output, /remote/)
    assert.match(result.output, /1 个工具/)
    assert.ok(!Number.isNaN(Date.parse(result.checkedAt)))
    const lines = await readFile(log, 'utf8')
    assert.match(lines, /tools\/list/)
    const pid = Number(lines.match(/started:(\d+)/)![1])
    assert.throws(() => process.kill(pid, 0), /ESRCH/)
    await writeFile(file, '{"mcpServers":{"invalid":{"url":"file:///bad"}}}')
    assert.equal((await checkMcpServers(file)).exitCode, 1)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})

test('服务不响应时按超时结束，返回退出码和超时标记', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-mcp-timeout-'))
  const slow = path.join(directory, 'slow.mjs')
  const file = path.join(directory, 'mcp.json')
  try {
    await writeFile(slow, 'process.stdin.resume()\nsetInterval(() => {}, 1000)\n')
    await writeFile(
      file,
      JSON.stringify({
        mcpServers: {
          first: { command: process.execPath, args: [slow] },
          second: { command: process.execPath, args: [slow] },
        },
      }),
    )
    const result = await checkMcpServers(file, 800)
    assert.equal(result.timedOut, true)
    assert.equal(result.exitCode, 1)
    assert.match(result.output, /检查超时/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
