import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { link, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { test } from 'vitest'
import { AccessSandbox } from '../src/sdk/access-sandbox'
import { windowsNativeExecutable } from '@pi-meme/windows-native/runtime'
import { windowsRuntimeReadPaths, windowsSandboxEnvironment } from '@pi-meme/windows-native/sandbox'

const windows = { skip: process.platform !== 'win32', timeout: 30000 }

test('Windows 原生命令按只读与工作区写入权限执行，后代沿用限制且不继承秘密环境变量', windows, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'Pi 中文 沙箱 '))
  const cwd = path.join(root, '项目 空格')
  const temporary = path.join(root, '临时目录')
  const outside = path.join(root, '外部秘密')
  await Promise.all([mkdir(cwd), mkdir(temporary), writeFile(outside, 'original')])
  await promisify(execFile)('icacls.exe', [outside, '/grant', '*S-1-1-0:F'], { windowsHide: true })
  try {
    for (const mode of ['read-only', 'workspace-write'] as const) {
      const sandbox = await AccessSandbox.create({ mode, cwd, temporary, agentDir: path.join(root, 'agent') })
      try {
        const code = `const fs=require('node:fs');const cp=require('node:child_process');const write=p=>{try{fs.writeFileSync(p,'allowed');return true}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e;return false}};console.log(JSON.stringify({workspace:write(${JSON.stringify(path.join(cwd, mode))}),temporary:write(${JSON.stringify(path.join(temporary, mode))}),outside:write(${JSON.stringify(outside)}),env:!process.env.PI_MEME_FAKE_SECRET&&!process.env.NODE_OPTIONS&&!process.env.NODE_PATH,child:JSON.parse(cp.execFileSync(process.execPath,['-e',${JSON.stringify(`const fs=require('node:fs');let denied=false;try{fs.writeFileSync(${JSON.stringify(outside)},'forbidden')}catch(e){denied=['EPERM','EACCES'].includes(e.code)};console.log(JSON.stringify({denied,env:!process.env.PI_MEME_FAKE_SECRET}))`)}],{encoding:'utf8'}))}));`
        let output = ''
        const result = await sandbox.run(process.execPath, ['-e', code], {
          cwd,
          env: { PI_MEME_FAKE_SECRET: 'must-not-inherit', NODE_OPTIONS: '--trace-warnings', NODE_PATH: root },
          onData: (chunk) => {
            output += chunk.toString()
          },
          timeout: 10,
        })
        assert.equal(result.exitCode, 0, output)
        assert.deepEqual(JSON.parse(output), {
          workspace: mode === 'workspace-write',
          temporary: true,
          outside: false,
          env: true,
          child: { denied: true, env: true },
        })
        assert.equal(await readFile(outside, 'utf8'), 'original')
      } finally {
        await sandbox.stopAll()
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Windows 拒绝项目外硬链接，PSEC 阻止 junction 移动和新建越界硬链接', windows, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-psec-alias-'))
  const cwd = path.join(root, 'project')
  const temporary = path.join(root, 'temporary')
  const outside = path.join(root, 'outside')
  const dataRoot = path.join(root, 'host-data')
  await Promise.all([
    mkdir(path.join(cwd, 'links'), { recursive: true }),
    mkdir(temporary),
    mkdir(outside),
    mkdir(dataRoot, { recursive: true }),
  ])
  const original = path.join(outside, 'original')
  const secret = path.join(dataRoot, 'auth.json')
  await Promise.all([writeFile(original, 'original'), writeFile(secret, 'fake-secret')])
  const hardlink = path.join(cwd, 'links/hard')
  await link(original, hardlink)
  await symlink(outside, path.join(cwd, 'junction'), 'junction')
  await assert.rejects(
    AccessSandbox.create({ mode: 'workspace-write', cwd, temporary, agentDir: path.join(root, 'agent'), dataRoot }),
    /白名单外的硬链接/,
  )
  await unlink(hardlink)
  const inside = path.join(cwd, 'inside')
  await writeFile(inside, 'original')
  await link(inside, path.join(cwd, 'internal-link'))
  const sandbox = await AccessSandbox.create({
    mode: 'workspace-write',
    cwd,
    temporary,
    agentDir: path.join(root, 'agent'),
    dataRoot,
  })
  try {
    const paths = [original, path.join(cwd, 'junction/original'), secret]
    const code = `const fs=require('node:fs');const denied=fn=>{try{fn();return false}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e;return true}};fs.writeFileSync('internal-link','allowed');console.log(JSON.stringify({writes:${JSON.stringify(paths)}.map(p=>denied(()=>fs.writeFileSync(p,'forbidden'))),rename:denied(()=>{fs.renameSync('junction','moved');fs.writeFileSync('moved/original','forbidden')}),hardlink:denied(()=>fs.linkSync(${JSON.stringify(original)},'new-link')),secret:denied(()=>fs.readFileSync(${JSON.stringify(secret)}))}));`
    let output = ''
    const result = await sandbox.run(process.execPath, ['-e', code], {
      cwd,
      onData: (b) => {
        output += b
      },
      timeout: 10,
    })
    assert.equal(result.exitCode, 0, output)
    assert.deepEqual(JSON.parse(output), { writes: [true, true, true], rename: true, hardlink: true, secret: true })
    assert.equal(await readFile(inside, 'utf8'), 'allowed')
    assert.equal(await readFile(original, 'utf8'), 'original')
    assert.equal(await readFile(secret, 'utf8'), 'fake-secret')
  } finally {
    await sandbox.stopAll()
    await rm(root, { recursive: true, force: true })
  }
})

test('Windows PSEC 的取消、超时、停止和主进程自然结束均清理 detached 后代', windows, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-psec-tree-'))
  const cwd = path.join(root, 'project')
  const temporary = path.join(root, 'temporary')
  await Promise.all([mkdir(cwd), mkdir(temporary)])
  const sandbox = await AccessSandbox.create({
    mode: 'workspace-write',
    cwd,
    temporary,
    agentDir: path.join(root, 'agent'),
  })
  try {
    for (const method of ['abort', 'timeout', 'stopAll', 'exit'] as const) {
      const marker = path.join(cwd, method)
      const controller = new AbortController()
      const child = `const fs=require('node:fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(marker)},'tick\\n'),20)`
      const code = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{detached:true,stdio:'ignore'}).unref();${method === 'exit' ? 'setTimeout(()=>process.exit(0),500)' : 'setInterval(()=>{},1000)'}`
      const running = sandbox.run(process.execPath, ['-e', code], {
        cwd,
        signal: controller.signal,
        timeout: method === 'timeout' ? 1 : 10,
        onData: () => {},
      })
      const settled = running.catch((cause: Error) => cause)
      for (let i = 0; i < 200; i++) {
        try {
          await readFile(marker)
          break
        } catch {
          await delay(10)
        }
      }
      assert.match(await readFile(marker, 'utf8'), /tick/)
      if (method === 'abort') controller.abort()
      if (method === 'stopAll') await sandbox.stopAll()
      const result = await settled
      if (method === 'abort' || method === 'timeout') assert.ok(result instanceof Error)
      if (method === 'exit') assert.deepEqual(result, { exitCode: 0 })
      const stopped = await readFile(marker, 'utf8')
      await delay(150)
      assert.equal(await readFile(marker, 'utf8'), stopped, `${method} 后仍有后代写入`)
    }
    let output = ''
    const managed = await sandbox.startManaged(process.execPath, ['-e', 'console.log("受限服务");process.exit(7)'], {
      cwd,
      onData: (b) => {
        output += b
      },
    })
    assert.equal((await managed.completion).exitCode, 7)
    assert.match(output, /受限服务/)
  } finally {
    await sandbox.stopAll()
    await rm(root, { recursive: true, force: true })
  }
})

test('Windows PSEC 原生控制程序被强制结束时，内核仍清理全部后代', windows, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-psec-controller-'))
  const cwd = path.join(root, 'project')
  const temporary = path.join(root, 'temporary')
  await Promise.all([mkdir(cwd), mkdir(temporary)])
  const marker = path.join(cwd, 'marker')
  const childCode = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>fs.appendFileSync(${JSON.stringify(marker)},' tick'),20)`
  const code = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{detached:true,stdio:'ignore'});setInterval(()=>{},1000)`
  const helper = spawn(await windowsNativeExecutable(), [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const closed = new Promise<void>((resolve, reject) => {
    helper.once('error', reject)
    helper.once('close', () => resolve())
  })
  helper.stdout.resume()
  helper.stderr.resume()
  helper.stdin.on('error', () => {})
  helper.stdin.write(
    `${JSON.stringify({
      executable: process.execPath,
      args: ['-e', code],
      cwd,
      env: windowsSandboxEnvironment(temporary),
      sandbox: {
        read: [cwd, ...(await windowsRuntimeReadPaths(process.execPath))],
        write: [cwd, temporary],
        deny: [],
        allowNetwork: false,
        allowChildren: true,
      },
    })}\n`,
  )
  try {
    let contents = ''
    for (let i = 0; i < 300; i++) {
      try {
        contents = await readFile(marker, 'utf8')
        if (contents.includes('tick')) break
      } catch {
        /* 等待进程启动。 */
      }
      await delay(10)
    }
    assert.match(contents, /tick/)
    const pid = Number(contents.split(' ')[0])
    helper.kill('SIGKILL')
    await closed
    await delay(150)
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
    const stopped = await readFile(marker, 'utf8')
    await delay(100)
    assert.equal(await readFile(marker, 'utf8'), stopped)
  } finally {
    helper.kill('SIGKILL')
    await closed
    await rm(root, { recursive: true, force: true })
  }
})
