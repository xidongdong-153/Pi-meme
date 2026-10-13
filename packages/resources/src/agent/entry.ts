import path from 'node:path'
import type { PiRuntimePaths } from '@pi-meme/pi-runtime/runtime-paths'

export function create(context: {
  paths: PiRuntimePaths
  cwd: string
  registerResourcePolicy: (paths: { skills: string[]; prompts: string[] }) => void
}) {
  const project = path.join(context.cwd, '.pi')
  context.registerResourcePolicy({
    skills: [],
    prompts: [path.join(context.paths.agentDir, 'prompts'), path.join(project, 'prompts')],
  })
  return []
}
