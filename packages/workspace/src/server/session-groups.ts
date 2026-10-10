import path from 'node:path'
import type { PiProjectGroup, PiSessionsSnapshot, PiSessionSummary } from '@pi-meme/contracts/sessions'

export type SessionFile = { path: string; mtime: number }

export function groupSessions(
  allFiles: SessionFile[],
  filesByDir: Map<string, SessionFile[]>,
  summaryMap: Map<string, PiSessionSummary>,
  home: string,
) {
  // 构建最近会话列表（至多取前 30 个已解析文件）
  const recents: PiSessionSummary[] = []
  for (const f of allFiles) {
    const s = summaryMap.get(f.path)
    if (s) recents.push(s)
  }

  recents.sort(compareCompletedSessions)
  recents.splice(30)

  // 按项目分组
  const projects: PiProjectGroup[] = []
  for (const [dirName, files] of filesByDir.entries()) {
    if (files.length === 0) continue

    const projectSessions: PiSessionSummary[] = []
    let detectedCwd = ''

    for (const f of files) {
      const s = summaryMap.get(f.path)
      if (s) {
        projectSessions.push(s)
        if (!detectedCwd && s.cwd) detectedCwd = s.cwd
      } else {
        // 未预加载的内容，根据文件名和 mtime 生成轻量占位，后续展开时即时命中
        const id = path.basename(f.path).split('_')[1]?.replace('.jsonl', '') || ''
        projectSessions.push({
          id,
          path: f.path,
          cwd: detectedCwd,
          created: new Date(f.mtime).toISOString(),
          modified: new Date(f.mtime).toISOString(),
          messageCount: 0,
        })
      }
    }

    // 如果 session header 没读取到 cwd，从目录名反解析出大致路径（去掉前导与结尾的双连字符）
    if (!detectedCwd) {
      const cleaned = dirName.replace(/^--/, '').replace(/--$/, '')
      detectedCwd = `/${cleaned.split('-').join('/')}`
    }

    let projectName = path.basename(detectedCwd)
    if (detectedCwd === home) {
      projectName = '个人主目录'
    } else if (!projectName) {
      projectName = detectedCwd
    }

    projects.push({
      cwd: detectedCwd,
      name: projectName,
      sessionCount: files.length,
      lastModified: projectSessions.reduce(
        (latest, session) => (session.completedAt && session.completedAt > latest ? session.completedAt : latest),
        '1970-01-01T00:00:00.000Z',
      ),
      sessions: projectSessions.sort(compareProjectSessions),
    })
  }

  projects.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime())

  return { recents, projects }
}

export function mergeRuntimeSessions(
  snapshot: PiSessionsSnapshot,
  runtimeSessions: PiSessionSummary[],
): PiSessionsSnapshot {
  if (!runtimeSessions.length) return snapshot
  const summaries = new Map(
    [...snapshot.projects.flatMap((project) => project.sessions), ...snapshot.recents].map((session) => [
      session.path,
      session,
    ]),
  )
  for (const session of runtimeSessions) {
    const saved = summaries.get(session.path)
    summaries.set(session.path, {
      ...saved,
      ...session,
      name: session.name ?? saved?.name,
      firstMessage: session.firstMessage ?? saved?.firstMessage,
      created: saved?.created ?? session.created,
      completedAt: session.completedAt === undefined ? saved?.completedAt : session.completedAt,
    })
  }
  const compare = compareCompletedSessions
  const projects = new Map(
    snapshot.projects.map((project) => [project.cwd, { ...project, sessions: [] as PiSessionSummary[] }]),
  )
  for (const session of summaries.values()) {
    let project = projects.get(session.cwd)
    if (!project) {
      project = {
        cwd: session.cwd,
        name: path.basename(session.cwd) || session.cwd,
        sessionCount: 0,
        lastModified: session.completedAt ?? '1970-01-01T00:00:00.000Z',
        sessions: [],
      }
      projects.set(session.cwd, project)
    }
    project.sessions.push(session)
  }
  for (const project of projects.values()) {
    project.sessions.sort(compareProjectSessions)
    project.sessionCount = project.sessions.length
    project.lastModified = project.sessions.reduce(
      (latest, session) => (session.completedAt && session.completedAt > latest ? session.completedAt : latest),
      project.lastModified,
    )
  }
  const recentPaths = new Set([...snapshot.recents, ...runtimeSessions].map((session) => session.path))
  return {
    ...snapshot,
    recents: [...summaries.values()].filter((session) => recentPaths.has(session.path)).sort(compare),
    projects: [...projects.values()].sort((a, b) => Date.parse(b.lastModified) - Date.parse(a.lastModified)),
  }
}

function compareProjectSessions(a: PiSessionSummary, b: PiSessionSummary) {
  return Date.parse(b.completedAt ?? b.created) - Date.parse(a.completedAt ?? a.created)
}

function compareCompletedSessions(a: PiSessionSummary, b: PiSessionSummary) {
  return (
    Date.parse(b.completedAt ?? '1970-01-01T00:00:00.000Z') - Date.parse(a.completedAt ?? '1970-01-01T00:00:00.000Z')
  )
}
