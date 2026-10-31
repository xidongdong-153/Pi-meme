import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { test, vi } from 'vitest'
import { setTimeout as delay } from 'node:timers/promises'
import { AccessSandbox, probeAccessSandbox } from '../src/sdk/access-sandbox'

test('Windows 探测保留原生沙箱失败原因，不自动降低权限', async () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  const create = vi.spyOn(AccessSandbox, 'create').mockRejectedValue(new Error('PSEC 原生隔离能力不可用'))
  try {
    const capability = await probeAccessSandbox()
    assert.equal(capability.supported, false)
    assert.match(capability.reason ?? '', /PSEC 原生隔离能力不可用/)
    assert.doesNotMatch(capability.reason ?? '', /bwrap|sandbox-exec/)
    assert.equal(create.mock.calls.length, 1)
  } finally {
    create.mockRestore()
    vi.unstubAllGlobals()
  }
})

test('AccessSandbox.create 拒绝将系统根目录或用户主目录授权为工作区', async (t) => {
  if (!['darwin', 'linux', 'win32'].includes(process.platform)) {
    t.skip('当前平台没有受支持的沙箱后端')
    return
  }

  const temporary = await mkdtemp(path.join(tmpdir(), 'sandbox-temp-'))
  const agentDir = await mkdtemp(path.join(tmpdir(), 'sandbox-agent-'))

  try {
    // 根目录
    await assert.rejects(
      () =>
        AccessSandbox.create({
          mode: 'workspace-write',
          cwd: '/',
          temporary,
          agentDir,
        }),
      /不能将用户目录、Pi 配置目录或系统临时目录整体授权为工作区/,
    )

    // 用户主目录
    await assert.rejects(
      () =>
        AccessSandbox.create({
          mode: 'workspace-write',
          cwd: homedir(),
          temporary,
          agentDir,
        }),
      /不能将用户目录、Pi 配置目录或系统临时目录整体授权为工作区/,
    )

    // agent 配置目录
    await assert.rejects(
      () =>
        AccessSandbox.create({
          mode: 'workspace-write',
          cwd: agentDir,
          temporary,
          agentDir,
        }),
      /不能将用户目录、Pi 配置目录或系统临时目录整体授权为工作区/,
    )
  } finally {
    await rm(temporary, { recursive: true, force: true })
    await rm(agentDir, { recursive: true, force: true })
  }
})

test('AccessSandbox read-only 模式拒绝任何本地文件修改', async (t) => {
  if (!['darwin', 'linux', 'win32'].includes(process.platform)) {
    t.skip('当前平台没有受支持的沙箱后端')
    return
  }

  const workspace = await mkdtemp(path.join(tmpdir(), 'sandbox-ws-'))
  const temporary = await mkdtemp(path.join(tmpdir(), 'sandbox-temp-'))
  const agentDir = await mkdtemp(path.join(tmpdir(), 'sandbox-agent-'))

  try {
    const sandbox = await AccessSandbox.create({
      mode: 'read-only',
      cwd: workspace,
      temporary,
      agentDir,
    })

    const targetFile = path.join(workspace, 'file.txt')
    await assert.rejects(() => sandbox.assertWritable(targetFile), /当前权限禁止修改本地文件/)
    await assert.rejects(() => sandbox.writeFile(targetFile, 'data'), /当前权限禁止修改本地文件/)
    await assert.rejects(() => sandbox.mkdir(path.join(workspace, 'nested')), /当前权限禁止修改本地文件/)
  } finally {
    await rm(workspace, { recursive: true, force: true })
    await rm(temporary, { recursive: true, force: true })
    await rm(agentDir, { recursive: true, force: true })
  }
})

test('AccessSandbox workspace-write 模式允许项目内写入与递归创建目录，拒绝越界写入', async (t) => {
  if (!['darwin', 'linux', 'win32'].includes(process.platform)) {
    t.skip('当前平台没有受支持的沙箱后端')
    return
  }

  const workspace = await realpath(await mkdtemp(path.join(tmpdir(), 'sandbox-ws-')))
  const temporary = await realpath(await mkdtemp(path.join(tmpdir(), 'sandbox-temp-')))
  const agentDir = await realpath(await mkdtemp(path.join(tmpdir(), 'sandbox-agent-')))
  const outsideDir = await realpath(await mkdtemp(path.join(tmpdir(), 'sandbox-outside-')))

  try {
    const sandbox = await AccessSandbox.create({
      mode: 'workspace-write',
      cwd: workspace,
      temporary,
      agentDir,
    })

    // 1. 允许在工作区内 mkdir 与写文件
    const subDir = path.join(workspace, 'sub', 'folder')
    await sandbox.mkdir(subDir)
    const fileInside = path.join(subDir, 'hello.txt')
    await sandbox.writeFile(fileInside, 'hello sandbox')
    const content = await readFile(fileInside, 'utf8')
    assert.equal(content, 'hello sandbox')

    // 2. 允许在会话临时目录内写文件
    const tempFile = path.join(temporary, 'temp.txt')
    await sandbox.writeFile(tempFile, 'temporary data')
    assert.equal(await readFile(tempFile, 'utf8'), 'temporary data')

    // 3. 拒绝写工作区外部文件
    const outsideFile = path.join(outsideDir, 'forbidden.txt')
    await assert.rejects(() => sandbox.assertWritable(outsideFile), /当前权限不允许写入项目外路径/)
    await assert.rejects(() => sandbox.writeFile(outsideFile, 'attack'), /当前权限不允许写入/)

    // 4. 拒绝路径穿越尝试 (..)
    const traverseFile = path.join(workspace, '..', path.basename(outsideDir), 'forbidden.txt')
    await assert.rejects(() => sandbox.assertWritable(traverseFile), /当前权限不允许写入项目外路径/)
  } finally {
    await rm(workspace, { recursive: true, force: true })
    await rm(temporary, { recursive: true, force: true })
    await rm(agentDir, { recursive: true, force: true })
    await rm(outsideDir, { recursive: true, force: true })
  }
})

test('bash 的写入、符号链接与 Host 数据边界由实际后端执行', async (t) => {
  if (!['darwin', 'linux'].includes(process.platform)) return t.skip('当前平台没有受支持的沙箱后端')
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'sandbox-boundaries-')))
  const project = path.join(root, 'project')
  const temporary = path.join(root, 'temporary')
  const dataRoot = path.join(root, 'data')
  const outside = path.join(root, 'outside')
  await Promise.all([project, temporary, dataRoot, outside].map((directory) => mkdir(directory)))
  await writeFile(path.join(outside, 'original'), 'original')
  await symlink(outside, path.join(project, 'escape'))
  try {
    for (const mode of ['workspace-write', 'read-only'] as const) {
      const sandbox = await AccessSandbox.create({ mode, cwd: project, temporary, agentDir: dataRoot, dataRoot })
      const run = async (command: string) => {
        let output = ''
        const result = await sandbox.run('/bin/bash', ['-c', command], {
          cwd: project,
          onData: (chunk) => {
            output += chunk.toString()
          },
          timeout: 5,
        })
        return {
          ...result,
          output,
          diagnostic: `权限：${mode}；命令：${command}；退出码：${result.exitCode}\n${output}`,
        }
      }
      const read = await run(`cat ${JSON.stringify(path.join(outside, 'original'))}`)
      assert.equal(read.exitCode, 0, read.diagnostic)
      assert.equal(read.output, 'original', read.diagnostic)
      const tempWrite = await run(`echo temporary > ${JSON.stringify(path.join(temporary, mode))}`)
      assert.equal(tempWrite.exitCode, 0, tempWrite.diagnostic)
      const projectWrite = await run('echo inside > inside')
      assert.equal(projectWrite.exitCode === 0, mode === 'workspace-write', projectWrite.diagnostic)
      for (const target of [
        path.join(outside, 'original'),
        path.join(project, 'escape/original'),
        path.join(dataRoot, 'auth.json'),
      ]) {
        const denied = await run(`echo forbidden > ${JSON.stringify(target)}`)
        assert.notEqual(denied.exitCode, 0, denied.diagnostic)
        await assert.rejects(sandbox.writeFile(target, 'forbidden'))
      }
      assert.equal(await readFile(path.join(outside, 'original'), 'utf8'), 'original')
      sandbox.stopAll()
    }
    const overlapping = await AccessSandbox.create({
      mode: 'workspace-write',
      cwd: root,
      temporary,
      agentDir: path.join(dataRoot, 'pi'),
      dataRoot,
    })
    const blocked = await overlapping.run(
      '/bin/bash',
      ['-c', `echo forbidden > ${JSON.stringify(path.join(dataRoot, 'auth.json'))}`],
      { cwd: root, onData: () => {}, timeout: 5 },
    )
    assert.notEqual(blocked.exitCode, 0)
    await assert.rejects(readFile(path.join(dataRoot, 'auth.json')), /ENOENT/)
    overlapping.stopAll()
    await assert.rejects(
      AccessSandbox.create({ mode: 'workspace-write', cwd: dataRoot, temporary, agentDir: dataRoot, dataRoot }),
      /配置目录|应用数据/,
    )
    await assert.rejects(
      AccessSandbox.create({ mode: 'workspace-write', cwd: tmpdir(), temporary, agentDir: dataRoot }),
      /不能将/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('能力探测保留 namespace 错误，实际启动失败不执行工具', async () => {
  const create = vi.spyOn(AccessSandbox, 'create').mockImplementation(async () => {
    throw new Error('bwrap: namespace: Operation not permitted')
  })
  const capability = await probeAccessSandbox()
  assert.equal(capability.supported, false)
  assert.match(capability.reason!, /namespace: Operation not permitted/)
  assert.equal(create.mock.calls.length, 1)
})

test('取消、超时和 stopAll 清理后台进程及 setsid 后代', { timeout: 15000 }, async (t) => {
  if (!['darwin', 'linux'].includes(process.platform)) return t.skip('当前平台没有受支持的沙箱后端')
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'sandbox-descendants-')))
  const project = path.join(root, 'project')
  const temporary = path.join(root, 'temporary')
  await Promise.all([mkdir(project), mkdir(temporary)])
  try {
    const sandbox = await AccessSandbox.create({
      mode: 'workspace-write',
      cwd: project,
      temporary,
      agentDir: path.join(root, 'agent'),
    })
    for (const method of ['abort', 'timeout', 'stopAll']) {
      const marker = path.join(project, method)
      const controller = new AbortController()
      const background = `while true; do echo tick >> ${JSON.stringify(marker)}; sleep 0.05; done`
      const command = `${process.platform === 'linux' ? 'setsid ' : ''}/bin/bash -c ${JSON.stringify(background)} & wait`
      const running = sandbox.run('/bin/bash', ['-c', command], {
        cwd: project,
        onData: () => {},
        signal: controller.signal,
        timeout: method === 'timeout' ? 0.4 : 5,
      })
      const settled = running.catch((error: Error) => error)
      for (let count = 0; count < 100; count++) {
        try {
          await readFile(marker)
          break
        } catch {
          await delay(10)
        }
      }
      assert.ok((await readFile(marker, 'utf8')).includes('tick'))
      if (method === 'abort') controller.abort()
      else if (method === 'stopAll') sandbox.stopAll()
      const result = await settled
      if (method !== 'stopAll') assert.ok(result instanceof Error)
      const stopped = await readFile(marker, 'utf8')
      await delay(150)
      assert.equal(await readFile(marker, 'utf8'), stopped, `${method} 后仍有后代写入`)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
