import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadPiAgentCore, loadPiSdk } from '../src/sdk/load'

test('Pi Agent Core 可通过 ESM 文件入口动态加载', async () => {
  const sdk = await loadPiAgentCore()
  assert.equal(typeof sdk.Agent, 'function')
})

test('Pi SDK 可动态提供 Markdown frontmatter 解析器', async () => {
  const sdk = await loadPiSdk()
  const parsed = sdk.parseFrontmatter('---\nname: worker\n---\nInspect the task.')
  assert.equal(parsed.frontmatter.name, 'worker')
  assert.equal(parsed.body.trim(), 'Inspect the task.')
})
