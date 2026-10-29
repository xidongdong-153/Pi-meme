import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const pnpm = process.env.npm_execpath
const platform = process.platform

if (platform !== 'darwin' && platform !== 'linux') {
  console.error(`开发入口不支持 ${platform}，请在 macOS 或 Linux/WSL 中运行 pnpm start。`)
  process.exitCode = 1
} else if (!pnpm) {
  console.error('请在仓库根目录通过 pnpm start 启动开发环境。')
  process.exitCode = 1
} else {
  console.log(
    platform === 'darwin' ? '启动 macOS 开发环境：Desktop + Host + Web。' : '启动 Linux 开发环境：Host + Web。',
  )
  const commands =
    platform === 'darwin'
      ? [{ name: 'Desktop', args: ['--filter', 'pi-meme', 'start'], allowSuccess: false }]
      : [
          { name: 'Host', args: ['run', 'start:server'], allowSuccess: true },
          { name: 'Web', args: ['run', 'start:web'], allowSuccess: false },
        ]
  const groups: number[] = []
  const finished = Promise.withResolvers<number>()
  const interrupt = () => finished.resolve(130)
  const terminate = () => finished.resolve(143)
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminate)

  function signalGroup(pid: number, signal: NodeJS.Signals | 0) {
    try {
      process.kill(-pid, signal)
      return true
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ESRCH') return false
      throw cause
    }
  }

  try {
    for (const command of commands) {
      const child = spawn(pnpm, command.args, {
        cwd: root,
        env: { ...process.env, NODE_ENV: 'development' },
        stdio: 'inherit',
        detached: true,
      })
      if (child.pid) groups.push(child.pid)
      child.once('error', (cause) => {
        console.error(`${command.name} 启动失败：${cause.message}`)
        finished.resolve(1)
      })
      child.once('exit', (code, signal) => {
        // Server 复用已有 Host 时成功退出，Web 仍需继续运行。
        if (code === 0 && command.allowSuccess) return
        if (code !== 0) console.error(`${command.name} 已退出：${signal ?? code ?? '未知原因'}。`)
        finished.resolve(code ?? 1)
      })
    }
    process.exitCode = await finished.promise
  } finally {
    for (const pid of groups) signalGroup(pid, 'SIGTERM')
    const deadline = Date.now() + 5000
    while (groups.some((pid) => signalGroup(pid, 0)) && Date.now() < deadline) await delay(100)
    for (const pid of groups) signalGroup(pid, 'SIGKILL')
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', terminate)
  }
}
