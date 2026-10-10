import type { PlatformAdapter } from '@pi-meme/contracts/host'

declare global {
  interface Window {
    piPlatform: PlatformAdapter
  }
}
