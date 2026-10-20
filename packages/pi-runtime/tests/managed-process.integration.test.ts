import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'vitest'
import { serviceProcessEnvironment, spawnManagedProcess } from '../src/sdk/managed-process'

const supported = process.platform === 'darwin' || process.platform === 'linux'

async function until(read: () => boolean) {
  for (let index = 0; index < 100; index++) {
    if (read()) return
    await delay(25)
  }
  throw new Error('等待进程输出超时')
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw cause
  }
}

test('托管进程确认启动并清除可能影响工具执行的环境变量', { skip: !supported }, async () => {
  let output = ''
  const child = await spawnManagedProcess(process.execPath, ['-e', 'console.log("ready"); setInterval(()=>{},1000)'], {
    cwd: process.cwd(),
    env: serviceProcessEnvironment({ NODE_OPTIONS: '--bad-option', BASH_ENV: '/bad/file' }),
    onData: (chunk) => (output += chunk.toString()),
  })
  try {
    await until(() => output.includes('ready'))
    const result = await child.stop()
    assert.equal(result.signal, 'SIGTERM')
    assert.equal(await child.stop(), result)
  } finally {
    child.kill()
  }
})

test('托管进程启动失败直接拒绝，不留下未处理的完成错误', { skip: !supported }, async () => {
  await assert.rejects(
    spawnManagedProcess('/this/executable/does/not/exist', [], {
      cwd: process.cwd(),
      env: serviceProcessEnvironment(),
      onData: () => {},
    }),
    /ENOENT/,
  )
})

test('服务自然退出清理仍运行的同组后代', { skip: !supported, timeout: 10000 }, async () => {
  let output = ''
  const source = `
    const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    console.log(child.pid);
    setTimeout(()=>process.exit(0),250);
  `
  const child = await spawnManagedProcess(process.execPath, ['-e', source], {
    cwd: process.cwd(),
    env: serviceProcessEnvironment(),
    onData: (chunk) => (output += chunk.toString()),
  })
  try {
    await until(() => /\d+/.test(output))
    const pid = Number(output.trim())
    const result = await child.completion
    assert.equal(result.exitCode, 0)
    assert.equal(alive(pid), false)
  } finally {
    child.kill()
  }
})

test('包装主进程先退出时仍给后代保留 TERM 清理宽限期', { skip: !supported }, async () => {
  let output = ''
  const descendant = `process.on('SIGTERM',()=>setTimeout(()=>{console.log('cleaned');process.exit(0)},150));console.log('ready');setInterval(()=>{},1000)`
  const child = await spawnManagedProcess(
    process.execPath,
    [
      '-e',
      `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit'});setInterval(()=>{},1000)`,
    ],
    {
      cwd: process.cwd(),
      env: serviceProcessEnvironment(),
      onData: (chunk) => (output += chunk.toString()),
    },
  )
  try {
    await until(() => output.includes('ready'))
    await child.stop()
    assert.match(output, /cleaned/)
  } finally {
    child.kill()
  }
})

test('包装父先退出且后代忽略 TERM 时完成结果等待强制清理', { skip: !supported, timeout: 10000 }, async () => {
  let output = ''
  const descendant = `process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)`
  const source = `
    const p=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','pipe','ignore']});
    p.stdout.once('data',()=>console.log('ready'));
    setInterval(()=>{},1000);
  `
  const child = await spawnManagedProcess(process.execPath, ['-e', source], {
    cwd: process.cwd(),
    env: serviceProcessEnvironment(),
    onData: (chunk) => (output += chunk.toString()),
  })
  try {
    await until(() => output.includes('ready'))
    const [stopped, completed] = await Promise.all([child.stop(), child.completion])
    assert.equal(stopped.signal, 'SIGTERM')
    assert.equal(completed.signal, 'SIGTERM')
  } finally {
    child.kill()
  }
})

test('忽略 TERM 的服务在宽限期后强制退出并确认进程组清理', { skip: !supported, timeout: 10000 }, async () => {
  let output = ''
  const child = await spawnManagedProcess(
    process.execPath,
    ['-e', 'process.on("SIGTERM",()=>{}); console.log("ready"); setInterval(()=>{},1000)'],
    {
      cwd: process.cwd(),
      env: serviceProcessEnvironment(),
      onData: (chunk) => (output += chunk.toString()),
    },
  )
  try {
    await until(() => output.includes('ready'))
    const result = await child.stop()
    assert.equal(result.signal, 'SIGKILL')
  } finally {
    child.kill()
  }
})
