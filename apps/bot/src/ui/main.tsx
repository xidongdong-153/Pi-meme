import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { TooltipProvider, ErrorBoundary } from './primitives'
import { App } from './app'
import './styles.css'
import './chat-experience.css'
import './ds-workspace.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TooltipProvider>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </TooltipProvider>
  </StrictMode>,
)
