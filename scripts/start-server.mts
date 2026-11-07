import { prepareDevelopmentRuntime } from './development-runtime.mjs'
import { runDevelopmentProcess } from './run-development-process.mjs'

const snapshot = await prepareDevelopmentRuntime()
await runDevelopmentProcess(snapshot.nodePath, [snapshot.serverPath])
