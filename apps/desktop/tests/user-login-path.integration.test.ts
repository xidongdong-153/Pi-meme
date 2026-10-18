import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, describe, test, vi } from 'vitest'

const roots: string[] = []
let warnings: string[] = []
beforeEach(() => {
  vi.resetModules()
  warnings = []
  vi.spyOn(console, 'warn').mockImplementation((value: string) => warnings.push(value))
})
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(rc: string) {
  const home = await mkdtemp(path.join(tmpdir(), 'pi-login-path 测试-'))
  roots.push(home)
  const shell = path.join(home, 'login shell')
  await writeFile(shell, '#!/bin/sh\nprintf "probe\\n" >> "$HOME/probes"\nexec /bin/zsh "$@"\n')
  await chmod(shell, 0o700)
  await writeFile(path.join(home, '.zshrc'), rc)
  const env = { HOME: home, ZDOTDIR: home, SHELL: shell, PATH: '/usr/bin:/bin', KEEP_VALUE: '原有变量' }
  const { prepareDesktopHostEnv } = await import('../src/main/user-login-path')
  return { home, env, prepare: prepareDesktopHostEnv }
}

describe.skipIf(process.platform !== 'darwin')('macOS 登录 Shell PATH', () => {
  test('忽略启动输出，保留路径空格和顺序，只读取 PATH，并缓存探测', async () => {
    const f = await fixture(
      'printf "启动提示\\n"\nexport PATH="$HOME/managed tools/bin:/usr/bin::/usr/bin:/bin"\nexport SHELL_ONLY_SECRET=不应导入\ntrap \'printf "退出提示\\n"\' EXIT\n',
    )
    const bin = path.join(f.home, 'managed tools/bin')
    await mkdir(bin, { recursive: true })
    for (const command of ['pnpm', 'ego-browser']) {
      const file = path.join(bin, command)
      await writeFile(file, `#!/bin/sh\nprintf '${command} 已找到\\n'\n`)
      await chmod(file, 0o700)
    }
    assert.equal(spawnSync('/bin/bash', ['-c', 'command -v pnpm'], { env: f.env }).status, 1)
    const [first, second] = await Promise.all([f.prepare(f.env), f.prepare(f.env)])
    assert.deepEqual(first, second)
    assert.deepEqual(first.PATH!.split(':').slice(0, 3), [bin, '/usr/bin', '/bin'])
    assert.equal(first.PATH!.split(':').filter((entry) => entry === '/usr/bin').length, 1)
    assert.ok(!first.PATH!.includes('启动提示'))
    assert.ok(!first.PATH!.includes('退出提示'))
    assert.equal(first.KEEP_VALUE, '原有变量')
    assert.equal(first.SHELL_ONLY_SECRET, undefined)
    assert.equal(f.env.PATH, '/usr/bin:/bin')
    for (const command of ['pnpm', 'ego-browser']) {
      const result = spawnSync('/bin/bash', ['-c', command], { env: first, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout.trim(), `${command} 已找到`)
    }
    await writeFile(path.join(f.home, '.zshrc'), 'export PATH=/changed\n')
    const third = await f.prepare({ ...f.env, PATH: '/inherited-new:/usr/bin:/bin' })
    assert.equal(third.PATH!.split(':')[0], bin)
    assert.ok(third.PATH!.includes('/inherited-new'))
    assert.equal(await readFile(path.join(f.home, 'probes'), 'utf8'), 'probe\n')
    assert.equal(warnings.length, 0)
  })

  test('无效的 SHELL 使用系统 Shell，补充已存在的用户工具目录', async () => {
    const f = await fixture('export PATH=/usr/bin:/bin\n')
    const bins = ['.local/bin', '.cargo/bin', 'Library/pnpm', 'custom-pnpm'].map((name) => path.join(f.home, name))
    await Promise.all(bins.map((bin) => mkdir(bin, { recursive: true })))
    const env = await f.prepare({ ...f.env, SHELL: path.join(f.home, 'missing'), PNPM_HOME: bins[3] })
    for (const bin of bins) assert.ok(env.PATH!.split(':').includes(bin))
    assert.equal(env.PATH!.split(':').filter((entry) => entry === bins[3]).length, 1)
    assert.equal(warnings.length, 0)
  })

  for (const [name, rc] of [
    ['非零退出', 'exit 7\n'],
    ['空结果', 'export PATH=""\n'],
    ['缺失输出边界', 'exit 0\n'],
  ]) {
    test(`${name}保留继承 PATH，失败只记录一次且不重新探测`, async () => {
      const f = await fixture(rc)
      const bin = path.join(f.home, '.local/bin')
      await mkdir(bin, { recursive: true })
      const first = await f.prepare(f.env)
      const second = await f.prepare(f.env)
      assert.equal(first.PATH!.split(':')[0], '/usr/bin')
      assert.ok(first.PATH!.split(':').includes(bin))
      assert.deepEqual(first, second)
      assert.equal(warnings.length, 1)
      assert.match(warnings[0], /无法恢复登录 Shell PATH/)
      assert.equal(await readFile(path.join(f.home, 'probes'), 'utf8'), 'probe\n')
    })
  }

  test('启动失败和输出过大均返回可用的继承 PATH', async () => {
    const f = await fixture('/usr/bin/yes x | /usr/bin/head -c 70000\n')
    const first = await f.prepare(f.env)
    assert.ok(first.PATH!.startsWith('/usr/bin:/bin'))
    assert.match(warnings[0], /输出超过 64 KiB/)
    vi.resetModules()
    const { prepareDesktopHostEnv } = await import('../src/main/user-login-path')
    const second = await prepareDesktopHostEnv({ ...f.env, HOME: path.join(f.home, 'missing') })
    assert.ok(second.PATH!.startsWith('/usr/bin:/bin'))
    assert.match(warnings[1], /无法启动探测进程/)
  })

  test('超过 5 秒结束探测并回收 Shell 和后代进程', async () => {
    const f = await fixture(
      'printf "%s" "$$" > "$HOME/shell.pid"\n/bin/sleep 30 &\nprintf "%s" "$!" > "$HOME/child.pid"\nwait\n',
    )
    const started = Date.now()
    const env = await f.prepare(f.env)
    assert.ok(Date.now() - started >= 4900)
    assert.ok(Date.now() - started < 8000)
    assert.ok(env.PATH!.startsWith('/usr/bin:/bin'))
    assert.match(warnings[0], /超过 5 秒/)
    for (const file of ['shell.pid', 'child.pid']) {
      const pid = Number(await readFile(path.join(f.home, file), 'utf8'))
      assert.ok(pid > 0)
      const deadline = Date.now() + 1000
      while (Date.now() < deadline) {
        try {
          process.kill(pid, 0)
        } catch {
          break
        }
        await delay(10)
      }
      assert.throws(() => process.kill(pid, 0), /ESRCH/)
    }
  })

  test('恢复后的环境传入 Worker，其 Bash 子进程直接找到用户工具', async () => {
    const f = await fixture('export PATH="$HOME/.local/bin:/usr/bin:/bin"\n')
    const bin = path.join(f.home, '.local/bin')
    await mkdir(bin, { recursive: true })
    const tool = path.join(bin, 'ego-browser')
    await writeFile(tool, '#!/bin/sh\nprintf "Worker 工具已找到\\n"\n')
    await chmod(tool, 0o700)
    const env = await f.prepare(f.env)
    const worker = new Worker(
      `const {parentPort}=require('node:worker_threads')
const {execFileSync}=require('node:child_process')
parentPort.postMessage({path:process.env.PATH,output:execFileSync('/bin/bash',['-c','ego-browser'],{encoding:'utf8'})})`,
      { eval: true, env },
    )
    try {
      const result = await new Promise<{ path: string; output: string }>((resolve, reject) => {
        worker.once('message', resolve)
        worker.once('error', reject)
      })
      assert.equal(result.path, env.PATH)
      assert.equal(result.output.trim(), 'Worker 工具已找到')
    } finally {
      await worker.terminate()
    }
  })
})

test('非 macOS 原样保留调用方环境，不探测 Shell', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: 'linux' })
  try {
    const { prepareDesktopHostEnv } = await import('../src/main/user-login-path')
    const env = { PATH: '/inherited::/inherited', SHELL: '/missing', KEEP_VALUE: '原有变量' }
    assert.deepEqual(await prepareDesktopHostEnv(env), env)
    assert.equal(warnings.length, 0)
  } finally {
    Object.defineProperty(process, 'platform', descriptor)
  }
})
