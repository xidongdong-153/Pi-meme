import { realpath } from 'node:fs/promises'
import path from 'node:path'
import type { PluginManifest } from '@pi-meme/plugin-sdk/manifest'
import type { ServerPluginContext } from '@pi-meme/plugin-sdk/server'
import {
  prefetchSessionHistory,
  readSessionHistory,
  type SessionHistoryData,
} from '@pi-meme/pi-runtime/session-history'
import type { PiSessionsSnapshot } from '@pi-meme/contracts/sessions'
import { text } from '@pi-meme/contracts/ipc'

type HistoryContext = {
  sessions: {
    getSessionsDirectory: () => Promise<string>
    getSnapshot: (active: unknown, pinned: string[]) => Promise<PiSessionsSnapshot>
  }
  pi: { getActiveSession: () => unknown }
  getPinnedPaths: () => string[]
  getRuntimeHistory?: (path: string) => SessionHistoryData | null
}
export const manifest: PluginManifest = {
  name: '@pi-meme/history',
  version: '0.1.0',
  piMeme: {
    sdkVersion: 2,
    server: 'dist/server/chord-facets.json',
    requires: ['host.workspace'],
  },
}

export function create(context: ServerPluginContext) {
  const host = context.services.require<HistoryContext>('host.workspace')
  const validate = async (value: unknown) => {
    text(value)
    if (value.startsWith('runtime:')) {
      const history = host.getRuntimeHistory?.(value)
      if (!history) throw new Error('运行中的会话不存在')
      return { path: value, history }
    }
    const directory = await realpath(await host.sessions.getSessionsDirectory())
    const target = await realpath(value)
    if (!target.startsWith(`${directory}${path.sep}`) || !target.endsWith('.jsonl'))
      throw new Error('会话不在 Host 会话目录内')
    return { path: target, history: undefined }
  }
  const read = async (value: unknown) => {
    const validated = await validate(value)
    return validated.history ?? readSessionHistory(validated.path)
  }
  context.registerHandlers({
    'session:history': read,
    'session:prefetch': async (value) => {
      const validated = await validate(value)
      if (!validated.history) await prefetchSessionHistory(validated.path)
    },
    'history:query': async (query) => {
      if (typeof query !== 'string' || query.length > 1024) throw new Error('历史查询必须是 1024 字符内的文本')
      const snapshot = await host.sessions.getSnapshot(host.pi.getActiveSession(), host.getPinnedPaths())
      const sessions = [
        ...new Map(
          [...snapshot.recents, ...snapshot.projects.flatMap((group) => group.sessions)].map((item) => [
            item.path,
            item,
          ]),
        ).values(),
      ]
      const needle = query.toLocaleLowerCase()
      return sessions.filter((item) =>
        `${item.name ?? ''} ${item.firstMessage ?? ''} ${item.cwd}`.toLocaleLowerCase().includes(needle),
      )
    },
    'history:export': async (value) => ({ format: 'pi-meme-history-v1', history: await read(value) }),
  })
}
