import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { AccessSandbox } from '../src/sdk/access-sandbox'

test('AccessSandbox.create 拒绝将系统根目录或用户主目录授权为工作区', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('macOS 专有测试')
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
  if (process.platform !== 'darwin') {
    t.skip('macOS 专有测试')
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
  if (process.platform !== 'darwin') {
    t.skip('macOS 专有测试')
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
