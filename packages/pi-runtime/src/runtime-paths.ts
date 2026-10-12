import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import path from 'node:path'

export type PiRuntimePaths = {
  dataRoot: string
  agentDir: string
  skillsDirectory: string
  extensionsDirectory: string
  builtinSkillsDirectory: string
  sessionsDirectory: string
  workspaceDataRoot: string
  secureCredentialsFile: string
  workspaceKey: (cwd: string) => string
  sessionDirectory: (cwd: string) => string
  workspaceDirectory: (cwd: string) => string
}

export function normalizeWorkspacePath(cwd: string) {
  try {
    return realpathSync.native(cwd)
  } catch {
    return path.resolve(cwd)
  }
}

export function workspaceKey(cwd: string) {
  return createHash('sha256').update(normalizeWorkspacePath(cwd)).digest('hex')
}

export function createPiRuntimePaths(userData: string): PiRuntimePaths {
  const root = path.join(userData, 'pi')
  const sessionsDirectory = path.join(userData, 'sessions')
  const workspaceDataRoot = path.join(userData, 'workspaces')
  const keyFor = (cwd: string) => workspaceKey(cwd)
  return {
    dataRoot: userData,
    agentDir: root,
    skillsDirectory: path.join(userData, 'skills'),
    extensionsDirectory: path.join(userData, 'extensions'),
    builtinSkillsDirectory: path.join(userData, 'builtin-resources', 'skills'),
    sessionsDirectory,
    workspaceDataRoot,
    secureCredentialsFile: path.join(userData, 'secure', 'credentials.bin'),
    workspaceKey: keyFor,
    sessionDirectory: (cwd) => path.join(sessionsDirectory, keyFor(cwd)),
    workspaceDirectory: (cwd) => path.join(workspaceDataRoot, keyFor(cwd)),
  }
}
