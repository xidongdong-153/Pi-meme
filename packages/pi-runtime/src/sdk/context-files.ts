import { readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

export type AgentContextFile = { path: string; content: string }

function isPathWithin(root: string, value: string) {
  const relative = path.relative(root, value)
  return relative === '' || (relative.split(path.sep)[0] !== '..' && !path.isAbsolute(relative))
}

export function readDesktopAgentContextFile(directory: string): AgentContextFile | undefined {
  let root: string
  try {
    root = realpathSync(directory)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw cause
  }

  for (const name of ['AGENTS.override.md', 'AGENTS.md']) {
    const candidate = path.join(root, name)
    try {
      const resolved = realpathSync(candidate)
      if (!isPathWithin(root, resolved) || !statSync(resolved).isFile()) continue
      return { path: resolved, content: readFileSync(resolved, 'utf8') }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw cause
    }
  }

  return undefined
}

/** 只读取 Desktop 与当前项目目录中的 AGENTS 文件，不扫描祖先目录或其他文件名。 */
export function readDesktopAgentContextFiles(cwd: string, agentDir: string): AgentContextFile[] {
  return [readDesktopAgentContextFile(agentDir), readDesktopAgentContextFile(cwd)].filter(
    (entry): entry is AgentContextFile => entry !== undefined,
  )
}
