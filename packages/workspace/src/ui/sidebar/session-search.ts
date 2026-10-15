import type { SessionSearchMatch } from '@pi-meme/contracts/sessions'
import type { SidebarSessionEntry } from './sidebar-model'

export type SessionSearchReader = (serviceId: string, query: string, paths: string[]) => Promise<SessionSearchMatch[]>
export type SidebarContentSearch = {
  matches: Array<{ key: string; excerpt: string }>
  errors: Array<{ serviceId: string; message: string }>
}

export async function searchSidebarContents(
  query: string,
  entries: SidebarSessionEntry[],
  read: SessionSearchReader,
): Promise<SidebarContentSearch> {
  const services = new Map<string, SidebarSessionEntry[]>()
  for (const entry of entries) {
    const group = services.get(entry.serviceId) ?? []
    group.push(entry)
    services.set(entry.serviceId, group)
  }
  const result: SidebarContentSearch = { matches: [], errors: [] }
  await Promise.all(
    [...services].map(async ([serviceId, group]) => {
      try {
        for (let start = 0; start < group.length; start += 100) {
          const batch = group.slice(start, start + 100)
          const byPath = new Map(batch.map((entry) => [entry.session.path, entry.key]))
          const matches = await read(serviceId, query, [...byPath.keys()])
          for (const match of matches) {
            const key = byPath.get(match.path)
            if (key) result.matches.push({ key, excerpt: match.excerpt })
          }
        }
      } catch (cause) {
        result.errors.push({ serviceId, message: String(cause) })
      }
    }),
  )
  return result
}
