import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'vitest'
import { spawnWindowsProcess } from '../src/process'
import { queryWindowsNative } from '../src/runtime'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const windows = process.platform === 'win32'
const options = { cwd: process.cwd(), env: process.env }
function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw cause
  }
}
async function childPid(output: import('node:stream').Readable) {
  let text = ''
  for await (const chunk of output) {
    text += String(chunk)
    if (text.includes('\n')) return Number(text.trim().split('\n')[0])
  }
  throw new Error('子进程未返回 PID')
}

test('Windows 原生启动保留中文、空格、引号、尾部反斜杠和环境变量', { skip: !windows }, async () => {
  const args = ['中文 project & x', 'a"b', 'C:\\path space\\', '']
  const child = await spawnWindowsProcess(
    process.execPath,
    ['-e', 'console.log(JSON.stringify({args:process.argv.slice(1),env:process.env.PI_TEST_NATIVE}))', ...args],
    { ...options, env: { ...process.env, PI_TEST_NATIVE: '中文 value' } },
  )
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  child.stdin.end()
  assert.equal((await child.completion).exitCode, 0)
  assert.deepEqual(JSON.parse(output), { args, env: '中文 value' })
})

test('Windows 主进程自然退出后清理仍运行的 detached 子进程', { skip: !windows }, async () => {
  const source = `const cp=require('node:child_process');const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});console.log(child.pid);child.unref()`
  const child = await spawnWindowsProcess(process.execPath, ['-e', source], options)
  const pid = await childPid(child.stdout)
  child.stdin.end()
  assert.equal((await child.completion).exitCode, 0)
  assert.equal(alive(pid), false)
})

test('Windows stop 等待整棵进程树退出，重复停止可用', { skip: !windows }, async () => {
  const source = `const cp=require('node:child_process');const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});console.log(child.pid);setInterval(()=>{},1000)`
  const child = await spawnWindowsProcess(process.execPath, ['-e', source], options)
  const pid = await childPid(child.stdout)
  assert.equal(alive(pid), true)
  child.stdin.end()
  await child.stop()
  assert.equal(alive(child.pid), false)
  assert.equal(alive(pid), false)
  await child.stop()
})

test('Windows 启动失败返回系统错误，不留下未完成的启动', { skip: !windows }, async () => {
  await assert.rejects(
    spawnWindowsProcess('C:\\pi-meme-missing-test\\missing.exe', [], options),
    /找不到|cannot find|os error 2/i,
  )
})

test('Windows 真实 DirectWrite 和编辑器注册信息可以读取', { skip: !windows }, async () => {
  const fonts = await queryWindowsNative('fonts')
  assert.ok(Array.isArray(fonts) && fonts.length > 0)
  assert.ok(fonts.some((font: { faces: Array<{ monospace: boolean }> }) => font.faces.some((face) => face.monospace)))
  const editors = await queryWindowsNative('editor-roots')
  assert.ok(Array.isArray(editors))
})

test('Windows 大文件标准输入按实际消费速度传输，不丢失字节', { skip: !windows, timeout: 15000 }, async () => {
  const child = await spawnWindowsProcess(
    process.execPath,
    [
      '-e',
      'const h=require("node:crypto").createHash("sha256");process.stdin.on("data",b=>h.update(b));process.stdin.on("end",()=>console.log(h.digest("hex")))',
    ],
    options,
  )
  const data = Buffer.alloc(12 * 1024 * 1024, 97)
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  await new Promise<void>((resolve, reject) => {
    child.stdin.once('error', reject)
    child.stdin.end(data, resolve)
  })
  assert.equal((await child.completion).exitCode, 0)
  assert.equal(output.trim(), createHash('sha256').update(data).digest('hex'))
})

test('Windows 控制方被强制结束时不留下原生受管进程', { skip: !windows, timeout: 15000 }, async () => {
  const module = pathToFileURL(path.resolve('packages/windows-native/src/process.ts')).href
  const source = `import {spawnWindowsProcess} from ${JSON.stringify(module)};const c=await spawnWindowsProcess(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:process.cwd(),env:process.env});console.log(c.pid);setInterval(()=>{},1000)`
  const owner = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    const pid = await childPid(owner.stdout)
    assert.ok(alive(pid))
    owner.kill('SIGKILL')
    for (let index = 0; index < 100 && alive(pid); index++) await delay(25)
    assert.equal(alive(pid), false)
  } finally {
    owner.kill('SIGKILL')
  }
})
