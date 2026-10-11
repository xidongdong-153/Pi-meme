import path from 'node:path'
import type { PiRuntimePaths } from '@pi-meme/pi-runtime/runtime-paths'

export function create(context: {
  paths: PiRuntimePaths
  cwd: string
  registerResourcePolicy: (paths: { skills: string[]; prompts: string[]; extensions: string[] }) => void
}) {
  const project = path.join(context.cwd, '.pi')
  context.registerResourcePolicy({
    skills: [
      context.paths.builtinSkillsDirectory,
      path.join(context.paths.agentDir, 'skills'),
      path.join(project, 'skills'),
    ],
    prompts: [path.join(context.paths.agentDir, 'prompts'), path.join(project, 'prompts')],
    extensions: [path.join(context.paths.agentDir, 'extensions'), path.join(project, 'extensions')],
  })
  return []
}
