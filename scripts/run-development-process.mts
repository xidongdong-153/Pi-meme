import { spawn } from 'node:child_process'

/** Run only published JS with a fixed executable; the owner child has no source TS loader or watcher. */
export async function runDevelopmentProcess(executable: string, args: string[]) {
  const env = { ...process.env }
  delete env.NODE_OPTIONS
  delete env.NODE_PATH
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(executable, args, { env, stdio: 'inherit', windowsHide: true })
  const interrupt = () => child.kill('SIGINT')
  const terminate = () => child.kill('SIGTERM')
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminate)
  try {
    process.exitCode = await new Promise<number>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code) => resolve(code ?? 1))
    })
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', terminate)
  }
}
