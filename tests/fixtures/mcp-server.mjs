import { createInterface } from 'node:readline'
import { appendFileSync } from 'node:fs'

export function mcpReply(message) {
  if (message.id === undefined) return undefined
  let result
  switch (message.method) {
    case 'initialize':
      result = {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'desktop-fixture', version: '1.0.0' },
      }
      break
    case 'tools/list':
      result = {
        tools: [
          {
            name: 'echo',
            description: '回显测试文本',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          },
        ],
      }
      break
    case 'tools/call':
      result = { content: [{ type: 'text', text: `MCP:${message.params.arguments.text}` }] }
      break
    case 'ping':
      result = {}
      break
    default:
      return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: '测试方法不存在' } }
  }
  return { jsonrpc: '2.0', id: message.id, result }
}

if (process.argv.includes('--stdio')) {
  if (process.env.MCP_FIXTURE_LOG) appendFileSync(process.env.MCP_FIXTURE_LOG, `started:${process.pid}\n`)
  const input = createInterface({ input: process.stdin })
  input.on('line', (line) => {
    const message = JSON.parse(line)
    if (process.env.MCP_FIXTURE_LOG) appendFileSync(process.env.MCP_FIXTURE_LOG, `${message.method}\n`)
    const reply = mcpReply(message)
    if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`)
  })
  input.on('close', () => process.exit(0))
}
