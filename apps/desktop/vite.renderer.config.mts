import path from 'node:path'
import { mergeConfig } from 'vite'
import { hostPort, localHostUrl } from '@pi-meme/contracts/host-runtime'
import { createWebConfig } from '../web/vite.config'

export default mergeConfig(createWebConfig(localHostUrl(hostPort(process.env.PI_MEME_PORT))), {
  root: path.resolve(__dirname, '../web'),
  build: { outDir: path.resolve(__dirname, '.vite/renderer/main_window') },
})
