import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runGit } from '@pi-meme/git/server/git-service'
import { createHost } from '../src/service'
import { systemPlugins } from '@pi-meme/plugin-sdk/system-plugins'

test('系统插件常驻且不可通过外部接口修改，文件写入按目标隔离并执行幂等检查', async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'system-tools-')))
  const host = await createHost({ dataRoot: path.join(root, 'data'), testCredentials: true })
  t.onTestFinished(async () => {
    await host.dispose()
    await rm(root, { recursive: true, force: true })
  })
  const list = await host.rpc({ requestId: 'list', clientId: 'test', method: 'plugins:list', args: [] })
  assert.deepEqual(list.result, systemPlugins)
  for (const plugin of systemPlugins) {
    for (const method of ['enable', 'disable', 'remove', 'reload']) {
      const response = await host.rpc({
        requestId: crypto.randomUUID(),
        clientId: 'test',
        method: `plugins:${method}`,
        args: [plugin.id],
      })
      assert.match(response.error?.message ?? '', /内置模块/)
    }
  }
  const a = path.join(root, 'a')
  const b = path.join(root, 'b')
  await mkdir(a)
  await mkdir(b)
  await writeFile(path.join(a, 'file.txt'), 'A')
  await writeFile(path.join(b, 'file.txt'), 'B')
  const project = await host.app.projects.register({ cwd: a }, { idempotencyKey: 'project' })
  const other = await host.app.projects.register({ cwd: b }, { idempotencyKey: 'other' })
  const session = await host.app.sessions.create({ project }, { idempotencyKey: 'session' })
  const otherSession = await host.app.sessions.create({ project: other }, { idempotencyKey: 'other-session' })
  await writeFile(path.join(a, 'same.png'), 'image-a')
  await writeFile(path.join(b, 'same.png'), 'image-b')
  for (const [ref, content] of [
    [session, 'image-a'],
    [otherSession, 'image-b'],
  ] as const) {
    const image = await host.app.files.preview(ref, 'same.png')
    assert.equal(image.kind, 'image')
    if (image.kind === 'image')
      assert.equal(image.dataUrl, `data:image/png;base64,${Buffer.from(content).toString('base64')}`)
  }
  await assert.rejects(async () => host.app.files.preview({ ...session, hostId: 'wrong-host' }, 'same.png'))
  await assert.rejects(async () => host.app.files.preview({ ...session, sessionId: 'missing-session' }, 'same.png'))
  const preview = await host.app.files.preview(session, 'file.txt')
  if (preview.kind !== 'text') throw new Error('必须是文本')
  const request = {
    apiVersion: 2 as const,
    clientId: 'test',
    method: 'files.write',
    idempotencyKey: 'save',
    args: [session, { relativePath: 'file.txt', content: 'saved', revision: preview.revision }],
  }
  const saved = await host.control.dispatch(request)
  assert.equal(saved.error, undefined)
  assert.deepEqual(await host.control.dispatch(request), saved)
  const conflict = await host.control.dispatch({
    ...request,
    args: [session, { relativePath: 'file.txt', content: 'different', revision: preview.revision }],
  })
  assert.equal(conflict.error?.code, 'idempotency-conflict')
  assert.equal(await readFile(path.join(a, 'file.txt'), 'utf8'), 'saved')
  await runGit(a, ['init', '-q'])
  assert.equal(await host.app.git.diff(session, { path: 'file.txt', kind: 'untracked' }), 'saved')
  assert.equal(await readFile(path.join(b, 'file.txt'), 'utf8'), 'B')
})
