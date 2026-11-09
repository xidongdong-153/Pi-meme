import type { MutationOptions, SessionRef } from '@pi-meme/contracts/app-host'
import type { MemoryEntry, MemoryEntryInput, MemoryQuery, MemoryScope } from '@pi-meme/contracts/memory'
import type { MemoryService } from '@pi-meme/memory/server/service'

/** Agent reads use execution scope; the UI's authenticated management API is intentionally broader. */
export function memorySystem(service: MemoryService, session: SessionRef, projectId?: string) {
  const allowed = (entry: MemoryEntry) => entry.scope.kind === 'global' || entry.scope.projectId === projectId
  const get = async (id: unknown) => {
    if (typeof id !== 'string' || !id || id.length > 256) throw new Error('记忆 ID 无效')
    const entry = await service.api.get(id)
    if (!allowed(entry)) throw new Error('不能访问其他项目的记忆')
    return entry
  }
  const input = (value: unknown, previous?: MemoryScope): MemoryEntryInput => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('记忆内容无效')
    const entry = value as MemoryEntryInput
    if (!entry.scope && !previous && !projectId) throw new Error('当前会话没有项目，请明确选择通用记忆范围')
    const scope: MemoryScope = entry.scope ?? previous ?? { kind: 'project', projectId: projectId! }
    if (scope.kind !== 'global' && (scope.kind !== 'project' || scope.projectId !== projectId))
      throw new Error('不能保存到其他项目的记忆')
    return { ...entry, scope }
  }
  return {
    async read(operation: string, args: unknown[]) {
      const status = await service.api.status()
      if (operation === 'memory.status') {
        return { ...status, jobs: status.jobs.filter((job) => job.projectId === projectId) }
      }
      if (!status.config.enabled) throw new Error('记忆已关闭；可在设置 → Agent → 记忆中管理已存内容')
      if (operation === 'memory.get') {
        const entry = await get(args[0])
        return { ...entry, sources: entry.sources.slice(0, 8), sourceCount: entry.sources.length }
      }
      if (operation !== 'memory.list' && operation !== 'memory.search') throw new Error('记忆读取操作无效')
      const query = (args[0] ?? {}) as MemoryQuery
      if (!query || typeof query !== 'object' || Array.isArray(query)) throw new Error('记忆查询无效')
      if (Object.keys(query).some((key) => !['query', 'cursor', 'limit'].includes(key)))
        throw new Error('记忆查询仅支持 query、cursor 和 limit')
      if (query.query !== undefined && (typeof query.query !== 'string' || query.query.length > 500))
        throw new Error('记忆搜索内容过长或无效')
      if (operation === 'memory.search' && !query.query?.trim()) throw new Error('搜索内容不能为空')
      const limit = query.limit ?? 20
      if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('记忆列表每页为 1–20 条')
      const entries: MemoryEntry[] = []
      let cursor = query.cursor
      let revision = status.revision
      for (let page = 0; page < 100 && entries.length < limit; page++) {
        const result = await service.api.list({ query: query.query, cursor, limit: 1 })
        revision = result.revision
        entries.push(...result.entries.filter(allowed))
        cursor = result.nextCursor
        if (!cursor) break
      }
      return {
        entries: entries.map((entry) => ({
          ...entry,
          content: entry.content.slice(0, 240),
          sources: entry.sources.slice(0, 2).map((source) => ({ ...source, excerpt: source.excerpt.slice(0, 100) })),
          sourceCount: entry.sources.length,
        })),
        nextCursor: cursor,
        revision,
      }
    },
    async write(operation: string, args: unknown[], mutation: MutationOptions) {
      if (session.hostId === '') throw new Error('记忆调用缺少执行身份')
      if (operation === 'memory.remember') {
        const status = await service.api.status()
        return service.api.create(input(args[0]), status.epoch, mutation)
      }
      const entry = await get(args[0])
      if (operation === 'memory.forget') return service.api.remove(entry.id, args[1] as number, mutation)
      if (operation === 'memory.update')
        return service.api.update(entry.id, input(args[1], entry.scope), args[2] as number, mutation)
      throw new Error('记忆写操作无效')
    },
  }
}
