import { createRoot } from 'react-dom/client'
import { ErrorBoundary } from '@pi-meme/ui/components/error-boundary'
import { WebApp } from './app'
import '@pi-meme/app-ui/global.css'

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary fallbackTitle="应用遇到未处理的错误">
    <WebApp />
  </ErrorBoundary>,
)
