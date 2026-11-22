import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { defaultHostPort, localHostUrl } from '@pi-meme/contracts/host-runtime'
import { activeAgentStatuses } from '@pi-meme/contracts/collaboration'
import type { Snapshot } from '@pi-meme/contracts/desktop'
import type { PiSessionsSnapshot } from '@pi-meme/contracts/sessions'
import { storageLayoutRelativePaths } from '@pi-meme/contracts/storage-paths'
import type { NodeHostClient } from '@pi-meme/client/node-host-client'
import { readLocalHostStatus } from '@pi-meme/host/host-status'
import type { LocalHostLease } from '@pi-meme/host/local-host'

const execute = promisify(execFile)
const label = 'ink.xdd.pi-meme-host'

function launchctl(...args: string[]) {
  return execute('/bin/launchctl', args, { encoding: 'utf8', timeout: 15_000 })
}

async function describeJob(target: string) {
  try {
    return (await launchctl('print', target)).stdout
  } catch (cause) {
    if ((cause as { code?: number }).code === 113) return undefined // launchd 未装载该服务。
    throw cause
  }
}

async function waitForJobExit(pid: number) {
  const deadline = Date.now() + 15_000
  for (;;) {
    try {
      process.kill(-pid, 0) // 登录项和它启动的 Node Host 属于同一进程组，只探测其是否仍存在。
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ESRCH') return
      throw cause
    }
    if (Date.now() >= deadline) throw new Error('Host 登录项的进程仍在退出，请稍后重试')
    await delay(100)
  }
}

async function jobServesHost(pid: number) {
  try {
    const { stdout } = await execute(
      '/usr/sbin/lsof',
      ['-nP', '-a', '-g', String(pid), `-iTCP@127.0.0.1:${defaultHostPort}`, '-sTCP:LISTEN', '-t'],
      { timeout: 5_000 },
    )
    return Boolean(stdout.trim())
  } catch (cause) {
    if ((cause as { code?: number }).code === 1) return false
    throw cause
  }
}

export async function findHostLoginItem(lease: LocalHostLease<unknown>) {
  if (process.platform !== 'darwin' || !process.getuid || lease.url !== localHostUrl()) return
  if (lease.ownership === 'attached' && lease.status.owner !== 'server') return
  const home = homedir()
  const plist = path.join(home, 'Library/LaunchAgents', `${label}.plist`)
  const installed = statSync(plist, { throwIfNoEntry: false })
  if (!installed?.isFile()) return
  const defaultRoot = await realpath(path.join(home, '.pi-meme')).catch((cause: unknown) => {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
  })
  if (lease.status.dataRoot !== defaultRoot) return

  const target = `gui/${process.getuid()}/${label}`
  const launcher = path.join(home, '.config/pi-meme-mcp/bin/start-host.mjs')
  function matches(description: string) {
    const lines = description.split('\n').map((line) => line.trim())
    const args = lines.indexOf('arguments = {')
    return (
      lines.includes(`path = ${plist}`) &&
      args >= 0 &&
      path.basename(lines[args + 1] ?? '') === 'node' &&
      lines[args + 2] === launcher &&
      lines[args + 3] === '}'
    )
  }
  const job = await describeJob(target)
  if (!job || !matches(job)) return

  const groupId = (description: string) => Number(description.match(/^\s*pid = (\d+)$/m)?.[1]) || undefined
  let group = groupId(job)
  if (lease.ownership === 'attached' && (!group || !(await jobServesHost(group)))) return
  return {
    async legacyRunningSessionCount(client: NodeHostClient, signal: AbortSignal) {
      // 旧版列表隐藏临时聊天。只检查已验证数据根下有无临时目录，不读取私有会话内容。
      const temporary = await readdir(
        path.join(lease.status.dataRoot, storageLayoutRelativePaths.temporarySessionsDirectory),
        { withFileTypes: true },
      )
      if (temporary.some((entry) => entry.isDirectory())) return undefined
      const snapshot = await client.rpc<PiSessionsSnapshot>('pi:sessions', [], { signal })
      const roots = new Map(
        [
          ...snapshot.recents,
          ...(snapshot.standaloneSessions ?? []),
          ...snapshot.projects.flatMap((group) => group.sessions),
        ].map((session) => [session.path, session] as const),
      )
      let count = 0
      for (const session of roots.values()) {
        if (session.running || session.needsInput) count++
        else if (session.id.startsWith('runtime:')) {
          const live = await client.rpc<Snapshot>('pi:snapshot', [{ limit: 1, details: 'deferred' }], {
            sessionId: session.id,
            signal,
          })
          if (
            live.state.isStreaming ||
            live.state.isCompacting ||
            live.state.retry ||
            (!live.state.stopped && !live.state.queuePaused && live.state.pendingMessageCount) ||
            live.appSession?.status === 'running' ||
            live.goal?.status === 'active' ||
            live.pendingInteractions?.length ||
            live.agents?.some((agent) => activeAgentStatuses.has(agent.status))
          )
            count++
        }
      }
      return count
    },
    async stop() {
      // 窗口确认关闭后复核当前登录项，以防用户在确认期间更换了服务。
      const current = await describeJob(target)
      if (!current) {
        const file = statSync(plist, { throwIfNoEntry: false })
        if (file?.ino === installed.ino && file.dev === installed.dev && file.mtimeMs === installed.mtimeMs)
          await launchctl('disable', target)
      } else if (matches(current)) {
        const currentGroup = groupId(current)
        if (lease.ownership === 'attached' && currentGroup !== group) {
          if (!currentGroup || !(await jobServesHost(currentGroup))) return
          const status = await readLocalHostStatus(lease.url)
          if (status?.instanceId !== lease.status.instanceId) return
        }
        group = currentGroup ?? group
        await launchctl('disable', target)
        try {
          await launchctl('bootout', target)
        } catch (cause) {
          if (await describeJob(target)) throw cause
        }
      }
      if (group) await waitForJobExit(group)
    },
  }
}
