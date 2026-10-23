import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { test } from 'vitest'
import { copyPiRuntime } from '../scripts/copy-pi-runtime.mjs'
import { createPiRuntimePaths } from '../packages/pi-runtime/src/runtime-paths'
import { userMessage } from './fixtures/messages.mjs'

test('隔离的桌面运行时重启后仍可新建、切换历史会话、改名和展开技能', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-meme-runtime-bundle-'))
  const repo = path.resolve(import.meta.dirname, '..')
  try {
    await copyPiRuntime(path.join(root, 'node_modules'))
    const sessions = createPiRuntimePaths(path.join(root, 'data')).sessionDirectory(root)
    await mkdir(sessions, { recursive: true })
    const timestamp = '2026-10-19T00:00:00Z'
    for (const name of ['first', 'second'])
      await writeFile(
        path.join(sessions, `${name}.jsonl`),
        [
          { type: 'session', version: 3, id: name, cwd: root, timestamp },
          { type: 'message', id: 'user', parentId: null, timestamp, message: userMessage(name, 1) },
        ]
          .map((entry) => JSON.stringify(entry))
          .join('\n'),
      )
    await writeFile(path.join(root, 'SKILL.md'), '---\nname: fixture\ndescription: 测试技能\n---\n检查历史会话')
    const outfile = path.join(root, '.vite/build/runtime.cjs')
    await build({
      stdin: {
        contents: `import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { PiSessionPool } from ${JSON.stringify(path.join(repo, 'packages/pi-runtime/src/session-pool.ts'))}
import { createPiRuntimePaths } from ${JSON.stringify(path.join(repo, 'packages/pi-runtime/src/runtime-paths.ts'))}
import { expandSkills } from ${JSON.stringify(path.join(repo, 'packages/pi-runtime/src/skill-prompt.ts'))}

async function main() {
  const root = process.argv[2]
  const runtimePaths = createPiRuntimePaths(path.join(root, 'data'))
  const sessions = runtimePaths.sessionDirectory(root)
  const pool = new PiSessionPool(root, {
    connection: () => {}, event: () => {}, error: () => {}, sessionsChanged: () => {},
  }, undefined, runtimePaths)
  try {
    pool.prepare(root)
    for (const name of ['first', 'second', 'first']) {
      await pool.newSession()
      const file = path.join(sessions, name + '.jsonl')
      const before = await readFile(file, 'utf8')
      const result = await pool.switchSession(file)
      assert.equal(result.cancelled, false)
      assert.equal(result.snapshot.connection.status, 'idle')
      assert.ok(result.snapshot.messages.some(message => message.role === 'user' && message.content === name))
      assert.equal(await readFile(file, 'utf8'), before, '浏览历史不能改写会话文件')
    }
    const first = path.join(sessions, 'first.jsonl')
    await pool.renameSession(first, '恢复后的会话')
    await pool.newSession()
    const renamed = await pool.switchSession(first)
    assert.equal(renamed.snapshot.state.sessionName, '恢复后的会话')
    const skill = {
      name: 'skill:fixture', resourceId: 'fixture', resourceRevision: '1', source: 'skill',
      sourceInfo: { path: path.join(root, 'SKILL.md'), scope: 'user', source: 'test', origin: 'top-level' },
    }
    const expanded = await expandSkills('\uFFFC', [{ id: 'fixture', revision: '1', name: 'skill:fixture' }], [skill])
    assert.match(expanded, /检查历史会话/)
    assert.doesNotMatch(expanded, /description:|\uFFFC/)
    console.log('隔离运行时会话恢复通过')
  } finally {
    await pool.stopAndWait()
  }
}
main().catch(cause => { console.error(cause); process.exitCode = 1 })`,
        resolveDir: repo,
      },
      outfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      external: ['@earendil-works/pi-coding-agent'],
      logLevel: 'silent',
    })
    for (let launch = 0; launch < 2; launch++) {
      const result = await promisify(execFile)(process.execPath, [outfile, root], { cwd: root, timeout: 15000 })
      assert.match(result.stdout, /隔离运行时会话恢复通过/)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
