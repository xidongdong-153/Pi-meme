import { homedir } from 'node:os'
import path from 'node:path'
import { defaultDevelopmentHostPort } from '@pi-meme/contracts/host-runtime'

process.env.NODE_ENV = 'development'
process.env.PI_MEME_PORT ??= String(defaultDevelopmentHostPort)
process.env.PI_MEME_DATA_ROOT ??= path.join(homedir(), '.pi-meme-dev')

await import('./main')
