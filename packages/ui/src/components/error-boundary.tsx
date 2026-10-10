import * as React from 'react'
import { AlertCircle, RotateCcw } from 'lucide-react'
import { Button } from './ui/button'

type Props = {
  children: React.ReactNode
  fallbackTitle?: string
}

type State = {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends React.Component<Props, State> {
  override state: State = {
    hasError: false,
    error: null,
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  override componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Unhandled React Render Error:', error, errorInfo)
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null })
  }

  override render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-full w-full flex-col items-center justify-center p-6 text-foreground select-none">
          <div className="flex max-w-md flex-col items-center text-center">
            <div className="mb-4 rounded-full bg-destructive/10 p-3 text-destructive">
              <AlertCircle className="size-8" />
            </div>
            <h2 className="mb-2 text-base font-semibold">{this.props.fallbackTitle || '界面渲染遇到错误'}</h2>
            <p className="mb-4 text-xs text-muted-foreground whitespace-pre-wrap max-h-32 overflow-y-auto">
              {this.state.error?.message || '发生未知渲染异常'}
            </p>
            <Button variant="outline" size="sm" onClick={this.handleReset} className="gap-2">
              <RotateCcw className="size-4" />
              重试加载
            </Button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
