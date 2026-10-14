import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'

const desktop = fileURLToPath(new URL('..', import.meta.url))
const output = path.join(desktop, 'out', 'desktop-smoke', `regression-${Date.now()}`)
const suites = [
  ['model', 'MODEL'],
  ['mcp', 'MCP'],
  ['select', 'SELECT'],
  ['image', 'IMAGE'],
  ['sidebar-menu', 'SIDEBAR'],
  ['sidebar-controls', 'SIDEBAR_CONTROLS'],
] as const
const results: Array<{ suite: string; code: number; log: string }> = []
let current: ReturnType<typeof spawn> | undefined
let interrupted = false
function stop() {
  interrupted = true
  if (current?.pid) process.kill(-current.pid, 'SIGTERM')
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
try {
  for (const [suite, flag] of suites) {
    if (interrupted) break
    const screenshots = path.join(output, suite)
    await mkdir(screenshots, { recursive: true })
    const temporary = await mkdtemp(path.join(tmpdir(), 'pi-desktop-regression-'))
    await Promise.all(['data', 'project'].map((name) => mkdir(path.join(temporary, name))))
    const env = { ...process.env }
    for (const key of Object.keys(env)) {
      if (/^PI_DESKTOP_.*(?:SMOKE_ONLY|REVIEW)$/.test(key)) delete env[key]
    }
    env[`PI_DESKTOP_${flag}_SMOKE_ONLY`] = '1'
    env.PI_DESKTOP_SMOKE_OUTPUT_DIR = screenshots
    env.PI_DESKTOP_SMOKE_TEMP_DIR = temporary
    console.log(`开始桌面专项：${suite}`)
    let log = ''
    let timedOut = false
    const child = spawn(electron as unknown as string, [path.join(desktop, 'tests/desktop-smoke.cjs')], {
      cwd: desktop,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    current = child
    const collect = (chunk: Buffer) => {
      log += chunk.toString()
      process.stdout.write(chunk)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const timer = setTimeout(() => {
      timedOut = true
      log += '\n桌面专项执行超过 120 秒，终止测试进程组。\n'
      if (child.pid) process.kill(-child.pid, 'SIGKILL')
    }, 120000)
    let code: number
    try {
      code = await new Promise<number>((resolve) => {
        child.once('error', (cause) => {
          log += `\n无法启动桌面专项：${String(cause)}\n`
          resolve(1)
        })
        child.once('close', (value) => resolve(timedOut ? 1 : (value ?? 1)))
      })
    } finally {
      clearTimeout(timer)
      current = undefined
      await rm(temporary, { recursive: true, force: true })
    }
    if (code === 0 && !log.includes(`桌面场景完成：${suite}`)) {
      code = 1
      log += '\n测试进程退出时未记录场景完成，不能判定为通过。\n'
    }
    const logFile = path.join(screenshots, 'run.log')
    await writeFile(logFile, log)
    results.push({ suite, code, log: logFile })
    console.log(`桌面专项${code === 0 ? '通过' : '失败'}：${suite}；日志：${logFile}`)
  }
  await writeFile(path.join(output, 'results.json'), `${JSON.stringify(results, null, 2)}\n`)
  console.log(
    `桌面专项汇总：${results.filter((result) => result.code === 0).length}/${suites.length} 通过；产物：${output}`,
  )
  process.exitCode =
    interrupted || results.length !== suites.length || results.some((result) => result.code !== 0) ? 1 : 0
} finally {
  process.removeListener('SIGINT', stop)
  process.removeListener('SIGTERM', stop)
}
