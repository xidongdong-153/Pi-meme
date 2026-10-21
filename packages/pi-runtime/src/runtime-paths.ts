import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { storageLayoutRelativePaths } from '@pi-meme/contracts/storage-paths'

export type PiRuntimePaths = {
  dataRoot: string
  agentDir: string
  skillsDirectory: string
  builtinSkillsDirectory: string
  sessionsDirectory: string
  workspaceDataRoot: string
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

export function createPiRuntimePaths(dataRoot: string): PiRuntimePaths {
  const rel = storageLayoutRelativePaths
  const agentDir = path.join(dataRoot, rel.agentDirectory)
  const sessionsDirectory = path.join(dataRoot, rel.sessionsDataDirectory)
  const workspaceDataRoot = path.join(dataRoot, rel.workspacesConfigDirectory)
  const keyFor = (cwd: string) => workspaceKey(cwd)
  return {
    dataRoot,
    agentDir,
    skillsDirectory: path.join(dataRoot, rel.skillsDirectory),
    builtinSkillsDirectory: path.join(dataRoot, rel.builtinSkillsDirectory),
    sessionsDirectory,
    workspaceDataRoot,
    workspaceKey: keyFor,
    sessionDirectory: (cwd) => path.join(sessionsDirectory, keyFor(cwd)),
    workspaceDirectory: (cwd) => path.join(workspaceDataRoot, keyFor(cwd)),
  }
}
