import { BrowserOverlay } from '@pi-meme/browser/ui/browser-overlay'
import type { BrowserOverlayPlatform } from '@pi-meme/contracts/browser'
import { createRoot } from 'react-dom/client'
import { ErrorBoundary } from '@pi-meme/ui/components/error-boundary'
import { WebApp } from './app'
import '@pi-meme/app-ui/global.css'

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary fallbackTitle="应用遇到未处理的错误">
    {window.piBrowserOverlay ? <BrowserOverlay platform={window.piBrowserOverlay} /> : <WebApp />}
  </ErrorBoundary>,
)

declare global {
  interface Window {
    piBrowserOverlay?: BrowserOverlayPlatform
  }
}
