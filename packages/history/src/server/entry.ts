import { realpath } from 'node:fs/promises'
import path from 'node:path'
import type {
  BuiltinModuleDescriptor as PluginManifest,
  BuiltinModuleContext as ServerPluginContext,
} from '@pi-meme/contracts/builtin-module'
import {
  prefetchSessionHistory,
  readSessionHistory,
  type SessionHistoryData,
} from '@pi-meme/pi-runtime/session-history'
import type { PiSessionsSnapshot, SessionSearchMatch } from '@pi-meme/contracts/sessions'
import { searchSessionFile, sessionSearchExcerpt } from './session-search'
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
    sdkVersion: 3,
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
    'session:search': async (query, values): Promise<SessionSearchMatch[]> => {
      if (typeof query !== 'string' || !query.trim() || query.length > 1024)
        throw new Error('历史搜索词必须是 1 到 1024 字符的文本')
      if (!Array.isArray(values) || values.length > 100 || values.some((value) => typeof value !== 'string'))
        throw new Error('每次历史搜索最多接受 100 个会话路径')
      const targets = await Promise.all(
        [...new Set(values as string[])].map(async (original) => {
          try {
            return { ...(await validate(original)), original }
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
            throw cause
          }
        }),
      )
      const needle = query.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
      const matches: SessionSearchMatch[] = []
      for (let start = 0; start < targets.length; start += 4) {
        const batch = await Promise.all(
          targets.slice(start, start + 4).map(async (target): Promise<SessionSearchMatch | undefined> => {
            if (!target) return
            const excerpt = target.history
              ? target.history.messages.map((message) => sessionSearchExcerpt(message, needle)).find(Boolean)
              : await searchSessionFile(target.path, needle)
            return excerpt === undefined ? undefined : { path: target.original, excerpt }
          }),
        )
        matches.push(...batch.filter((match): match is SessionSearchMatch => match !== undefined))
      }
      return matches
    },
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
