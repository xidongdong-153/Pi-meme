import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { copyFile, link, mkdir, mkdtemp, open, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { test } from 'vitest'
import { AccessSandbox, pathWithin } from '../src/sdk/access-sandbox'
import { windowsNativeExecutable } from '@pi-meme/windows-native/runtime'
import { spawnWindowsProcess } from '@pi-meme/windows-native/process'
import { windowsRuntimeReadPaths, windowsSandboxEnvironment } from '@pi-meme/windows-native/sandbox'

const windows = { skip: process.platform !== 'win32', timeout: 30000 }

test('Windows 原生程序位于项目内时仍可受限写入，执行副本固定在项目外', windows, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-psec-runtime-'))
  const cwd = path.join(root, 'project')
  const temporary = path.join(root, 'temporary')
  await Promise.all([mkdir(cwd), mkdir(temporary)])
  const source = path.join(cwd, 'pi-meme-windows.exe')
  await copyFile(await windowsNativeExecutable(), source)
  const previous = process.env.PI_MEME_WINDOWS_NATIVE
  process.env.PI_MEME_WINDOWS_NATIVE = source
  let sandbox: Awaited<ReturnType<typeof AccessSandbox.create>> | undefined
  try {
    sandbox = await AccessSandbox.create({
      mode: 'workspace-write',
      cwd,
      temporary,
      agentDir: path.join(root, 'agent'),
    })
    const runtime = await windowsNativeExecutable()
    assert.equal(pathWithin(cwd, runtime), false)
    assert.equal(process.env.PI_MEME_WINDOWS_NATIVE, runtime)
    await writeFile(source, '项目内的构建产物已更改')
    const target = path.join(cwd, 'allowed.txt')
    await sandbox.writeFile(target, 'allowed')
    assert.equal(await readFile(target, 'utf8'), 'allowed')
    const outside = path.join(root, 'outside.txt')
    await writeFile(outside, 'original')
    const code = `const fs=require('node:fs');console.log(JSON.stringify(${JSON.stringify([outside, runtime])}.map(p=>{try{fs.closeSync(fs.openSync(p,'r+'));return false}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e;return true}})))`
    let output = ''
    const result = await sandbox.run(process.execPath, ['-e', code], {
      cwd,
      onData: (chunk) => {
        output += chunk
      },
      timeout: 10,
    })
    assert.equal(result.exitCode, 0, output)
    assert.deepEqual(JSON.parse(output), [true, true])
    assert.equal(await readFile(outside, 'utf8'), 'original')
    await assert.rejects(
      AccessSandbox.create({
        mode: 'workspace-write',
        cwd: path.dirname(runtime),
        temporary,
        agentDir: path.join(root, 'agent'),
      }),
      /不能包含应用原生运行时/,
    )
  } finally {
    if (previous === undefined) delete process.env.PI_MEME_WINDOWS_NATIVE
    else process.env.PI_MEME_WINDOWS_NATIVE = previous
    await sandbox?.stopAll()
    await rm(root, { recursive: true, force: true })
  }
})

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

test('Windows 的 pnpm 共享依赖可读且保持硬链接，源码和缓存可写，共享文件及其新别名不可写', windows, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-psec-pnpm-'))
  const cwd = path.join(root, 'project')
  const temporary = path.join(root, 'temporary')
  const store = path.join(root, 'store')
  const other = path.join(root, 'other-project')
  const dependency = path.join(cwd, 'node_modules/.pnpm/shared@1.0.0/node_modules/shared')
  const hoisted = path.join(cwd, 'node_modules/hoisted')
  const local = path.join(cwd, 'packages/local')
  await Promise.all([
    mkdir(dependency, { recursive: true }),
    mkdir(hoisted, { recursive: true }),
    mkdir(local, { recursive: true }),
    mkdir(temporary),
    mkdir(store),
    mkdir(other),
  ])
  const original = path.join(store, 'index.cjs')
  const shared = path.join(dependency, 'index.cjs')
  const another = path.join(other, 'index.cjs')
  const contents = 'module.exports = "shared-dependency"'
  await writeFile(original, contents)
  await Promise.all([link(original, shared), link(original, another), link(original, path.join(hoisted, 'index.cjs'))])
  await writeFile(path.join(dependency, 'package.json'), '{"main":"index.cjs"}')
  await writeFile(path.join(hoisted, 'package.json'), '{"main":"index.cjs"}')
  await writeFile(path.join(local, 'index.cjs'), 'module.exports = "workspace-package"')
  await writeFile(path.join(local, 'package.json'), '{"main":"index.cjs"}')
  await symlink(dependency, path.join(cwd, 'node_modules/shared'), 'junction')
  await symlink(local, path.join(cwd, 'node_modules/local'), 'junction')
  const identity = await stat(shared, { bigint: true })
  let sandbox: Awaited<ReturnType<typeof AccessSandbox.create>> | undefined
  try {
    sandbox = await AccessSandbox.create({
      mode: 'workspace-write',
      cwd,
      temporary,
      agentDir: path.join(root, 'agent'),
    })
    const code = `const fs=require('node:fs');const path=require('node:path');const denied=fn=>{try{fn();return false}catch(e){if(!['EPERM','EACCES','EBUSY'].includes(e.code))throw e;return true}};const original=${JSON.stringify(original)};const shared=${JSON.stringify(shared)};const result={dependency:require('shared'),hoisted:require('hoisted'),local:require('local'),hoistedWrite:denied(()=>fs.writeFileSync('node_modules/hoisted/index.cjs','bad')),write:denied(()=>fs.writeFileSync(shared,'bad')),append:denied(()=>fs.appendFileSync(shared,'bad')),truncate:denied(()=>fs.truncateSync(shared)),attributes:denied(()=>fs.utimesSync(shared,0,0)),fileRename:denied(()=>{fs.renameSync(shared,'moved-shared.cjs');fs.writeFileSync('moved-shared.cjs','bad')}),outside:denied(()=>fs.writeFileSync(original,'bad')),newAlias:denied(()=>{fs.linkSync(shared,'alias.cjs');fs.writeFileSync('alias.cjs','bad')})};fs.writeFileSync('source.ts','allowed');fs.writeFileSync('node_modules/local/index.cjs','allowed');fs.mkdirSync('node_modules/.vite');fs.writeFileSync('node_modules/.vite/cache','allowed');result.rename=denied(()=>{fs.renameSync('node_modules','moved-dependencies');fs.writeFileSync(path.join('moved-dependencies','.pnpm/shared@1.0.0/node_modules/shared/index.cjs'),'bad')});console.log(JSON.stringify(result))`
    let output = ''
    const result = await sandbox.run(process.execPath, ['-e', code], {
      cwd,
      timeout: 10,
      onData: (chunk) => {
        output += chunk
      },
    })
    assert.equal(result.exitCode, 0, output)
    assert.deepEqual(JSON.parse(output), {
      dependency: 'shared-dependency',
      hoisted: 'shared-dependency',
      local: 'workspace-package',
      hoistedWrite: true,
      write: true,
      append: true,
      truncate: true,
      attributes: true,
      fileRename: true,
      outside: true,
      newAlias: true,
      rename: true,
    })
    assert.equal(await readFile(path.join(cwd, 'source.ts'), 'utf8'), 'allowed')
    assert.equal(await readFile(path.join(local, 'index.cjs'), 'utf8'), 'allowed')
    assert.equal(await readFile(original, 'utf8'), contents)
    assert.equal(await readFile(another, 'utf8'), contents)
    const after = await stat(original, { bigint: true })
    assert.equal(after.ino, identity.ino)
    assert.equal(after.nlink, identity.nlink)
    assert.equal(after.mtimeNs, identity.mtimeNs)
    assert.equal(await readFile(path.join(cwd, 'node_modules/.vite/cache'), 'utf8'), 'allowed')
    const released = await open(original, 'r+')
    await released.close()
  } finally {
    await sandbox?.stopAll()
    await rm(root, { recursive: true, force: true })
  }
})

test('Windows 已安装依赖中的硬链接仍不能读取显式受保护路径', windows, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-psec-protected-link-'))
  const cwd = path.join(root, 'project')
  const temporary = path.join(root, 'temporary')
  const dependency = path.join(cwd, 'node_modules/.pnpm/shared@1.0.0/node_modules/shared')
  const secret = path.join(root, 'secret')
  await Promise.all([mkdir(dependency, { recursive: true }), mkdir(temporary), writeFile(secret, 'fake-secret')])
  await link(secret, path.join(dependency, 'secret'))
  try {
    await assert.rejects(
      spawnWindowsProcess(process.execPath, ['-e', 'process.exit(0)'], {
        cwd,
        env: windowsSandboxEnvironment(temporary),
        sandbox: {
          read: [cwd, ...(await windowsRuntimeReadPaths(process.execPath))],
          write: [cwd, temporary],
          deny: [secret],
          allowNetwork: false,
          allowChildren: true,
        },
      }),
      /受保护路径的硬链接/,
    )
    assert.equal(await readFile(secret, 'utf8'), 'fake-secret')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Windows 共享硬链接保持只读，PSEC 阻止 junction 移动和新建越界硬链接', windows, async () => {
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
  const writer = await open(original, 'r+')
  try {
    await assert.rejects(
      AccessSandbox.create({ mode: 'workspace-write', cwd, temporary, agentDir: path.join(root, 'agent'), dataRoot }),
      /无法锁定共享硬链接文件/,
    )
  } finally {
    await writer.close()
  }
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
    const paths = [original, path.join(cwd, 'junction/original'), secret, hardlink]
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
    assert.deepEqual(JSON.parse(output), {
      writes: [true, true, true, true],
      rename: true,
      hardlink: true,
      secret: true,
    })
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
