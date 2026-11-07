import { prepareDevelopmentRuntime } from './development-runtime.mjs'
import { runDevelopmentProcess } from './run-development-process.mjs'

const snapshot = await prepareDevelopmentRuntime({ desktop: true })
await runDevelopmentProcess(snapshot.electronPath, [snapshot.root])
