import path from 'node:path'
import { mergeConfig } from 'vite'
import webConfig from '../web/vite.config'

export default mergeConfig(webConfig, {
  root: path.resolve(__dirname, '../web'),
  build: { outDir: path.resolve(__dirname, '.vite/renderer/main_window') },
})
