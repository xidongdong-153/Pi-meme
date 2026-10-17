import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { featureHelp, requiredBuilds, selectTests } from '../tests/selection'

const root = fileURLToPath(new URL('..', import.meta.url))
process.chdir(root)
const help = `测试必须明确选择范围：
  pnpm test --feature sessions
  pnpm test --feature sessions --layer integration
  pnpm test --feature sessions --layer e2e --target web
  pnpm test --file <路径> --name <名称模式>
  pnpm test --feature sessions --list
  pnpm test --all --layer unit,component,integration
  pnpm test:all

可用功能：
${featureHelp()}`
let current: ReturnType<typeof spawn> | undefined
let interrupted = false
let escalation: ReturnType<typeof setTimeout> | undefined
function signalCurrent(signal: NodeJS.Signals) {
  if (!current?.pid) return
  try {
    if (process.platform === 'win32') current.kill(signal)
    else process.kill(-current.pid, signal)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') throw cause
  }
}
function stop() {
  interrupted = true
  signalCurrent('SIGTERM')
  escalation ??= setTimeout(signalCurrent, 5000, 'SIGKILL')
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
const steps: Array<{ name: string; seconds: number; code: number; log: string }> = []
const output = path.join(root, 'out/tests', `${Date.now()}-${process.pid}`)

async function run(name: string, args: string[]) {
  if (interrupted) throw new Error('测试已取消。')
  console.log(`\n开始：${name}`)
  const start = performance.now()
  let log = ''
  const child = spawn(process.execPath, args, {
    cwd: root,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  current = child
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk)
      log += chunk.toString()
    })
  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (value) => resolve(value ?? 1))
  })
  current = undefined
  clearTimeout(escalation)
  escalation = undefined
  const logFile = path.join(output, `${steps.length + 1}.log`)
  await writeFile(logFile, log)
  steps.push({
    name,
    seconds: Math.round((performance.now() - start) / 10) / 100,
    code,
    log: path.relative(root, logFile),
  })
  if (code || interrupted) throw new Error(`${name}${interrupted ? '已取消' : `失败（退出码 ${code}）`}。`)
  return log
}

try {
  const selection = selectTests(process.argv.slice(2))
  if (selection.help) console.log(help)
  else {
    const builds = requiredBuilds(selection.suites, {
      serverBundle: Boolean(process.env.PI_MEME_HOST_BUNDLE_ROOT),
      desktopApp: Boolean(process.env.PI_DESKTOP_PACKAGED_APP),
    })
    console.log(`测试范围：${selection.suites.length} 个文件；当前平台：${process.platform}`)
    for (const suite of selection.suites) console.log(`  [${suite.layer}/${suite.target}] ${suite.file}`)
    if (builds.length) console.log(`必要构建：${builds.join('、')}`)
    if (!selection.list) {
      await mkdir(output, { recursive: true })
      const source = selection.suites.filter((suite) => ['unit', 'component', 'integration'].includes(suite.layer))
      if (source.length) {
        const resultFile = path.join(output, 'vitest.json')
        await run('源码测试', [
          'node_modules/vitest/vitest.mjs',
          'run',
          ...source.map((suite) => suite.file),
          '--reporter=dot',
          '--reporter=json',
          `--outputFile.json=${resultFile}`,
          ...(selection.name ? ['--testNamePattern', selection.name] : []),
          ...(selection.coverage ? ['--coverage'] : []),
        ])
        const results = JSON.parse(await readFile(resultFile, 'utf8')) as {
          numPassedTests: number
          numFailedTests: number
        }
        if (results.numPassedTests + results.numFailedTests === 0) throw new Error('没有实际执行的源码用例。')
      }
      for (const build of builds) {
        if (!process.env.npm_execpath) throw new Error('包含构建的测试请通过 pnpm test 执行。')
        await run(`构建 ${build}`, [process.env.npm_execpath, build])
      }
      const e2e = selection.suites.filter((suite) => suite.layer === 'e2e')
      process.env.PI_MEME_TEST_REPORT_DIR = path.join(output, 'playwright')
      if (e2e.length)
        await run('端到端测试', [
          'node_modules/@playwright/test/cli.js',
          'test',
          ...e2e.map((suite) => suite.file),
          ...(selection.name ? ['--grep', selection.name] : []),
        ])
      const artifacts = selection.suites.filter((suite) => suite.layer === 'artifact')
      if (artifacts.length) {
        const log = await run('产物验收', [
          '--import',
          'tsx',
          '--test',
          '--test-concurrency=1',
          '--test-reporter=tap',
          ...(selection.name ? ['--test-name-pattern', selection.name] : []),
          ...artifacts.map((suite) => suite.file),
        ])
        if (!Number(log.match(/^# tests (\d+)/m)?.[1])) throw new Error('没有实际执行的产物用例。')
      }
      console.log(`\n测试完成；报告：${path.relative(root, output)}`)
    }
  }
} catch (cause) {
  console.error(`\n${cause instanceof Error ? cause.message : String(cause)}`)
  if (process.argv.length === 2) console.error(help)
  process.exitCode = 1
} finally {
  process.removeListener('SIGINT', stop)
  process.removeListener('SIGTERM', stop)
  clearTimeout(escalation)
  if (steps.length) {
    await mkdir(output, { recursive: true })
    await writeFile(
      path.join(output, 'summary.json'),
      `${JSON.stringify({ platform: process.platform, steps, success: !process.exitCode }, null, 2)}\n`,
    )
  }
}
