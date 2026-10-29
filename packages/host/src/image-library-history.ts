import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { HostApi } from '@pi-meme/contracts/app-host'
import type { ImageArtifact } from '@pi-meme/contracts/image-generation'
import type { ImageLibraryCandidate, ImageLibraryHistory } from '@pi-meme/image-generation/server/library-store'
import { loadPiSdk } from '@pi-meme/pi-runtime/sdk/load'

export async function imageLibraryHistory(api: HostApi, sessionsDirectory: string): Promise<ImageLibraryHistory[]> {
  const [sessions, projects, root] = await Promise.all([
    api.sessions.list(),
    api.projects.list(),
    realpath(sessionsDirectory),
  ])
  const result: ImageLibraryHistory[] = []
  for (const session of sessions.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (session.temporary || !session.sessionFile) continue
    const file = session.sessionFile
    try {
      const resolved = await realpath(file)
      if (!resolved.startsWith(`${root}${path.sep}`) || resolved !== path.resolve(file)) continue
      const info = await stat(file)
      result.push({
        key: session.sessionId,
        revision: `${info.size}:${info.mtimeMs}:${info.ctimeMs}`,
        read: async () => {
          const { parseSessionEntries } = await loadPiSdk()
          const entries = parseSessionEntries(await readFile(file, 'utf8'))
          const byId = new Map(entries.filter((entry) => entry.type !== 'session').map((entry) => [entry.id, entry]))
          const images: ImageLibraryCandidate[] = []
          for (const entry of entries) {
            if (
              entry.type !== 'message' ||
              entry.message.role !== 'toolResult' ||
              entry.message.toolName !== 'image_gen' ||
              entry.message.isError
            )
              continue
            const artifact = (entry.message.details as { artifact?: ImageArtifact } | undefined)?.artifact
            if (
              !artifact ||
              typeof artifact.id !== 'string' ||
              typeof artifact.path !== 'string' ||
              artifact.mimeType !== 'image/png' ||
              typeof artifact.model !== 'string' ||
              !['generate', 'edit'].includes(artifact.operation)
            )
              continue
            const toolCallId = entry.message.toolCallId
            let prompt = ''
            let parent = entry.parentId ? byId.get(entry.parentId) : undefined
            const visited = new Set<string>()
            while (parent && !visited.has(parent.id)) {
              visited.add(parent.id)
              if (parent.type === 'message' && parent.message.role === 'assistant') {
                const call = parent.message.content.find(
                  (part) => part.type === 'toolCall' && part.name === 'image_gen' && part.id === toolCallId,
                )
                if (call?.type === 'toolCall') {
                  prompt = typeof call.arguments?.prompt === 'string' ? call.arguments.prompt : ''
                  break
                }
              }
              parent = parent.parentId ? byId.get(parent.parentId) : undefined
            }
            images.push({
              artifact,
              prompt,
              createdAt: entry.timestamp,
              session: { hostId: session.hostId, sessionId: session.sessionId },
              project: session.project,
              projectName: projects.find((project) => project.projectId === session.project?.projectId)?.name,
            })
          }
          return images
        },
      })
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    }
  }
  return result
}
